import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  Type,
  type Content,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Part,
} from '@google/genai';
import Exa, {
  DEFAULT_GET_CONTENTS_TOOL_DESCRIPTION,
  SEARCH_OBJECTIVE_TOOL_DESCRIPTION,
} from 'exa-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT =
  process.env.NODE_ENV === 'production' ? Number(process.env.PORT) || 3000 : 3000;

interface ChatAttachmentInput {
  name: string;
  dataUrl: string;
}

interface ChatMessageInput {
  role: 'user' | 'model';
  text: string;
  attachments?: ChatAttachmentInput[];
}

interface ChatRequestBody {
  messages?: ChatMessageInput[];
  model?: string;
  thinkingMode?: 'low' | 'high' | 'deep';
  persona?: string;
  useSearch?: boolean;
  ledgerContext?: string;
}

interface GroundingSource {
  title: string;
  uri: string;
}

const PERSONA_INSTRUCTIONS: Record<string, string> = {
  coach:
    'You are the Senior Execution & Psychology Coach inside Ledgerwise FX. Review setups, entry timing, checklist grades, Setup Watch windows, Fear Cards, and R-multiple discipline. Be direct, practical, and grounded in the trader’s logged numbers.',
  risk:
    'You are the Prop Desk & Risk Auditor inside Ledgerwise FX. Focus strictly on prop-firm daily loss room, max drawdown buffers, risk-ladder step compliance, position sizing, charter rules, and breach prevention.',
  cfo:
    'You are the Trader Finance CFO inside Ledgerwise FX. Focus on the payout waterfall (gross → split → fees → tax reserve → net), dual-currency USD/KES conversion, business vs household budget, runway months, and savings goals.',
  macro:
    'You are the FX Macro & Market Catalyst Analyst inside Ledgerwise FX. Analyze central bank policy, yields, major FX pairs, gold/XAUUSD drivers, and session catalysts with crisp tradeable takeaways.',
};

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function extractFriendlyError(err: unknown): { status: number; message: string } {
  let raw = err instanceof Error ? err.message : 'Unexpected Gemini API error occurred.';
  let status =
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;

  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as {
        error?: { code?: number; message?: string; status?: string };
      };
      if (parsed?.error?.code && typeof parsed.error.code === 'number') {
        status = parsed.error.code;
      }
      if (parsed?.error?.message) {
        raw = parsed.error.message;
      }
    } catch {
      // keep raw message
    }
  }

  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw)) {
    status = 429;
    raw =
      'Gemini API quota limit reached (429). You can add a free TAVILY_API_KEY, SERPER_API_KEY, or EXA_API_KEY in Settings > Secrets for full web search, or toggle Web search off.';
  }

  return {
    status: status >= 400 && status < 600 ? status : 500,
    message: raw,
  };
}

function getConfiguredSearchProvider(): 'exa' | 'tavily' | 'serper' | null {
  if (process.env.EXA_API_KEY?.trim()) return 'exa';
  if (process.env.TAVILY_API_KEY?.trim()) return 'tavily';
  if (process.env.SERPER_API_KEY?.trim()) return 'serper';
  return null;
}

function stripCdata(raw: string): string {
  return raw
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssItems(xml: string, limit = 5): Array<{ title: string; link: string; pubDate: string }> {
  const items: Array<{ title: string; link: string; pubDate: string }> = [];
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemMatches.slice(0, limit)) {
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(block);
    const dateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block);
    const title = titleMatch ? stripCdata(titleMatch[1]) : '';
    const link = linkMatch ? stripCdata(linkMatch[1]) : '';
    const pubDate = dateMatch ? stripCdata(dateMatch[1]) : '';
    if (title && link) {
      items.push({ title, link, pubDate });
    }
  }
  return items;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 6500): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchExternalWeb(
  query: string,
  objective?: string
): Promise<{
  provider: string;
  answer?: string;
  results: Array<{ title: string; url: string; snippet: string; date?: string }>;
  sources: GroundingSource[];
}> {
  let lastErr: unknown = null;

  const exaKey = process.env.EXA_API_KEY?.trim();
  if (exaKey) {
    try {
      const exa = new Exa(exaKey);
      const searchResponse = await exa.search(query, {
        ...(objective && objective.trim() ? { objective: objective.trim() } : {}),
        type: 'auto',
        contents: { highlights: true },
      });
      const results = (searchResponse.results ?? [])
        .filter((r) => Boolean(r.url))
        .map((r) => {
          const highlights = Array.isArray((r as { highlights?: unknown }).highlights)
            ? ((r as { highlights?: string[] }).highlights ?? []).join('\n')
            : '';
          return {
            title: r.title || r.url || 'Exa Result',
            url: r.url,
            snippet: highlights,
            date: r.publishedDate,
          };
        });
      return {
        provider: 'Exa Search',
        results,
        sources: results.map((r) => ({ title: r.title, uri: r.url })),
      };
    } catch (err) {
      lastErr = err;
    }
  }

  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    try {
      const resp = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Tavily search failed (${resp.status}).`);
      }
      const json = (await resp.json()) as {
        answer?: string;
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const results = (json.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({
          title: r.title || r.url || 'Source',
          url: r.url!,
          snippet: (r.content || '').slice(0, 600),
        }));
      return {
        provider: 'Tavily Search',
        answer: json.answer,
        results,
        sources: results.map((r) => ({ title: r.title, uri: r.url })),
      };
    } catch (err) {
      lastErr = err;
    }
  }

  const serperKey = process.env.SERPER_API_KEY?.trim();
  if (serperKey) {
    try {
      const resp = await fetchWithTimeout('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': serperKey,
        },
        body: JSON.stringify({ q: query, num: 6 }),
      });
      if (!resp.ok) {
        throw new Error(`Serper search failed (${resp.status}).`);
      }
      const json = (await resp.json()) as {
        answerBox?: { answer?: string; snippet?: string };
        organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
      };
      const results = (json.organic ?? [])
        .filter((r) => r.link)
        .map((r) => ({
          title: r.title || r.link || 'Result',
          url: r.link!,
          snippet: r.snippet || '',
          date: r.date,
        }));
      return {
        provider: 'Serper (Google SERP)',
        answer: json.answerBox?.answer || json.answerBox?.snippet,
        results,
        sources: results.map((r) => ({ title: r.title, uri: r.url })),
      };
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }
  throw new Error('No external search API key is configured.');
}

async function fetchExaContents(urls: string[]): Promise<{
  results: Array<{ url: string; title: string; text: string; publishedDate?: string }>;
  statuses: Array<{ id?: string; status?: string; error?: unknown }>;
  sources: GroundingSource[];
}> {
  const exaKey = process.env.EXA_API_KEY?.trim();
  if (!exaKey) {
    throw new Error('EXA_API_KEY is not configured.');
  }
  const cleanUrls = urls.map((u) => u.trim()).filter(Boolean).slice(0, 5);
  if (cleanUrls.length === 0) {
    return { results: [], statuses: [], sources: [] };
  }
  const exa = new Exa(exaKey);
  const response = await exa.getContents(cleanUrls, { text: true });
  const statuses = Array.isArray((response as { statuses?: unknown }).statuses)
    ? ((response as { statuses?: Array<{ id?: string; status?: string; error?: unknown }> }).statuses ?? [])
    : [];
  const results = (response.results ?? [])
    .filter((r) => Boolean(r.url))
    .map((r) => ({
      url: r.url,
      title: r.title || r.url,
      text: typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : '',
      publishedDate: r.publishedDate,
    }));
  return {
    results,
    statuses,
    sources: results.map((r) => ({ title: r.title, uri: r.url })),
  };
}

async function fetchLiveFxMarketData(opts: {
  baseCurrency?: string;
  includeCalendar?: boolean;
  includeCentralBankNews?: boolean;
}): Promise<{
  data: Record<string, unknown>;
  sources: GroundingSource[];
}> {
  const base = (opts.baseCurrency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
  const includeCal = opts.includeCalendar !== false;
  const includeNews = opts.includeCentralBankNews !== false;

  const sources: GroundingSource[] = [];
  const data: Record<string, unknown> = { fetchedAtUtc: new Date().toISOString() };

  const tasks: Array<Promise<void>> = [];

  tasks.push(
    (async () => {
      try {
        const res = await fetchWithTimeout(`https://open.er-api.com/v6/latest/${base}`);
        if (res.ok) {
          const json = (await res.json()) as {
            time_last_update_utc?: string;
            rates?: Record<string, number>;
          };
          const wanted = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'KES', 'ZAR', 'CNY'];
          const picked: Record<string, number> = {};
          for (const code of wanted) {
            if (json.rates && typeof json.rates[code] === 'number') {
              picked[code] = json.rates[code];
            }
          }
          data.fxRates = {
            base,
            updatedUtc: json.time_last_update_utc || '',
            rates: picked,
          };
          sources.push({
            title: `Live FX Spot Rates (${base})`,
            uri: 'https://www.exchangerate-api.com',
          });
          return;
        }
      } catch {
        // fallback to Frankfurter
      }

      try {
        const res = await fetchWithTimeout(`https://api.frankfurter.dev/v1/latest?base=${base}`);
        if (res.ok) {
          const json = (await res.json()) as { date?: string; rates?: Record<string, number> };
          data.fxRates = {
            base,
            updatedDate: json.date || '',
            rates: json.rates ?? {},
          };
          sources.push({
            title: `ECB Reference FX Rates (${base})`,
            uri: 'https://frankfurter.dev',
          });
        }
      } catch {
        // ignore rate failure
      }
    })()
  );

  if (includeCal) {
    tasks.push(
      (async () => {
        try {
          const res = await fetchWithTimeout(
            'https://biquote.io/api/calendar?importance=high,medium&countries=US,EU,GB,JP,CA,AU,CH,NZ'
          );
          if (res.ok) {
            const events = (await res.json()) as Array<{
              time?: string;
              currency?: string;
              countryCode?: string;
              name?: string;
              importance?: string;
              actual?: unknown;
              forecast?: unknown;
              previous?: unknown;
              unit?: string;
            }>;
            data.economicCalendar = (Array.isArray(events) ? events : []).slice(0, 16).map((ev) => ({
              timeUtc: ev.time,
              currency: ev.currency,
              country: ev.countryCode,
              event: ev.name,
              importance: ev.importance,
              actual: ev.actual,
              forecast: ev.forecast,
              previous: ev.previous,
              unit: ev.unit,
            }));
            sources.push({
              title: 'Economic Calendar (High & Medium Impact)',
              uri: 'https://biquote.io',
            });
          }
        } catch {
          // ignore calendar failure
        }
      })()
    );
  }

  if (includeNews) {
    tasks.push(
      (async () => {
        const newsItems: Array<{ source: string; title: string; link: string; pubDate: string }> = [];
        try {
          const fedRes = await fetchWithTimeout('https://www.federalreserve.gov/feeds/press_monetary.xml');
          if (fedRes.ok) {
            const xml = await fedRes.text();
            for (const item of parseRssItems(xml, 4)) {
              newsItems.push({ source: 'Federal Reserve', ...item });
            }
            sources.push({
              title: 'Federal Reserve Monetary Policy RSS',
              uri: 'https://www.federalreserve.gov/feeds/feeds.htm',
            });
          }
        } catch {
          // ignore
        }
        try {
          const ecbRes = await fetchWithTimeout('https://www.ecb.europa.eu/rss/press.html');
          if (ecbRes.ok) {
            const xml = await ecbRes.text();
            for (const item of parseRssItems(xml, 4)) {
              newsItems.push({ source: 'ECB', ...item });
            }
            sources.push({
              title: 'ECB Official Press Releases',
              uri: 'https://www.ecb.europa.eu/home/html/rss.en.html',
            });
          }
        } catch {
          // ignore
        }
        if (newsItems.length > 0) {
          data.centralBankReleases = newsItems;
        }
      })()
    );
  }

  await Promise.allSettled(tasks);
  return { data, sources };
}

const searchWebDeclaration: FunctionDeclaration = {
  name: 'searchWeb',
  description:
    'Search the live web and return the most relevant URLs and highlights. Use for fresh information, forex news, macro headlines, central bank updates, prop-firm rules, or anything beyond training data.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          'Natural-language search query describing the ideal page or topic. Put recency phrasing like "latest" or "recent" in the query when fresh results are needed.',
      },
      objective: {
        type: Type.STRING,
        description: SEARCH_OBJECTIVE_TOOL_DESCRIPTION,
      },
    },
    required: ['query', 'objective'],
  },
};

const getWebContentsDeclaration: FunctionDeclaration = {
  name: 'getWebContents',
  description: DEFAULT_GET_CONTENTS_TOOL_DESCRIPTION,
  parameters: {
    type: Type.OBJECT,
    properties: {
      urls: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Array of known HTTP/HTTPS URLs to extract full page text from.',
      },
    },
    required: ['urls'],
  },
};

const getLiveFxMarketDataDeclaration: FunctionDeclaration = {
  name: 'getLiveFxMarketData',
  description:
    'Fetch live FX spot exchange rates (including USD, EUR, GBP, JPY, KES), upcoming high/medium-impact economic calendar events, and latest Federal Reserve / ECB press releases.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      baseCurrency: {
        type: Type.STRING,
        description: '3-letter base currency code such as USD, EUR, or GBP. Defaults to USD.',
      },
      includeCalendar: {
        type: Type.BOOLEAN,
        description: 'Whether to include upcoming economic calendar releases.',
      },
      includeCentralBankNews: {
        type: Type.BOOLEAN,
        description: 'Whether to include latest Fed and ECB monetary policy releases.',
      },
    },
  },
};

function buildSystemInstruction(
  persona: string,
  ledgerContext?: string,
  isVoice = false,
  searchProvider?: 'exa' | 'tavily' | 'serper' | null
): string {
  const base = PERSONA_INSTRUCTIONS[persona] ?? PERSONA_INSTRUCTIONS.coach;
  const styleRule = isVoice
    ? 'This is a live spoken conversation. Keep answers concise, natural, conversational, and easy to follow without reading long tables aloud. Reference specific figures from the trader’s ledger when relevant.'
    : 'Keep responses crisp, structured, and actionable. Reference the trader’s exact figures, accounts, and rules when available. Format money and R-multiples clearly.';

  const searchGuidance =
    !isVoice && searchProvider === 'exa'
      ? `LIVE WEB & FOREX NEWS TOOL GUIDANCE (Exa):
- Call \`searchWeb\` whenever the user asks for live web information, recent forex news, central bank commentary, macro events, prop-firm policy updates, or anything after training cutoff. Call \`getLiveFxMarketData\` alongside it whenever exact FX spot rates (including KES), the economic calendar, or official Fed/ECB RSS releases help.
- Call \`getWebContents\` when the user gives a specific URL or when you need the full text of a URL returned by \`searchWeb\`. Always inspect the \`statuses\` array in \`getWebContents\` results before relying on a URL.
- When calling \`searchWeb\`, write \`query\` as clean natural-language retrieval intent describing the ideal page (express recency like "latest" or "recent" directly in \`query\`; never put keep/drop clauses like "only" or "exclude" inside \`query\`). Use the required \`objective\` parameter to state the goal for that turn: which authoritative sources should rank first (e.g., central banks, Reuters, Bloomberg, FXStreet, TradingEconomics, official prop-firm docs), which low-signal pages to exclude, and which specific facts, levels, or dates to extract.
- Ground all live claims in the returned tool outputs and reference retrieved sources accurately without inventing URLs or prices.`
      : !isVoice && searchProvider
        ? `LIVE WEB & FOREX NEWS TOOL GUIDANCE:
- Use \`searchWeb\` for live web lookups and forex/macro news, and \`getLiveFxMarketData\` for spot FX rates, economic calendar events, and Fed/ECB RSS releases. Ground claims in tool outputs and cite returned sources.`
        : '';

  return [
    base,
    styleRule,
    searchGuidance,
    ledgerContext && ledgerContext.trim()
      ? `LIVE LEDGERWISE FX SNAPSHOT:\n${ledgerContext.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function mergeSources(existing: GroundingSource[], incoming: GroundingSource[]): GroundingSource[] {
  const seen = new Set(existing.map((s) => s.uri));
  const out = [...existing];
  for (const s of incoming) {
    if (s.uri && !seen.has(s.uri)) {
      seen.add(s.uri);
      out.push(s);
    }
  }
  return out;
}

async function runToolAugmentedChat(opts: {
  ai: GoogleGenAI;
  model: string;
  contents: Content[];
  systemInstruction: string;
  thinkingLevel: ThinkingLevel;
  includeExternalWebSearch: boolean;
  includeExaGetContents?: boolean;
}): Promise<{ reply: string; sources: GroundingSource[]; providerLabel: string }> {
  const declarations: FunctionDeclaration[] = opts.includeExternalWebSearch
    ? opts.includeExaGetContents
      ? [searchWebDeclaration, getWebContentsDeclaration, getLiveFxMarketDataDeclaration]
      : [searchWebDeclaration, getLiveFxMarketDataDeclaration]
    : [getLiveFxMarketDataDeclaration];

  let allSources: GroundingSource[] = [];
  const providersUsed = new Set<string>();
  const workingContents: Content[] = [...opts.contents];

  for (let round = 0; round < 3; round++) {
    const response = await opts.ai.models.generateContent({
      model: opts.model,
      contents: workingContents,
      config: {
        systemInstruction: opts.systemInstruction,
        thinkingConfig: { thinkingLevel: opts.thinkingLevel },
        tools: [{ functionDeclarations: declarations }],
      },
    });

    const calls = response.functionCalls;
    const prevContent = response.candidates?.[0]?.content;

    if (!calls || calls.length === 0 || !prevContent) {
      return {
        reply: response.text ?? 'No response text generated.',
        sources: allSources,
        providerLabel: Array.from(providersUsed).join(' + ') || 'Live FX Feeds',
      };
    }

    workingContents.push(prevContent);
    const responseParts: Part[] = [];

    for (const call of calls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      if (call.name === 'searchWeb' && opts.includeExternalWebSearch) {
        try {
          const q = typeof args.query === 'string' ? args.query : '';
          const obj = typeof args.objective === 'string' ? args.objective : undefined;
          const searchResult = await searchExternalWeb(q, obj);
          providersUsed.add(searchResult.provider);
          allSources = mergeSources(allSources, searchResult.sources);
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                provider: searchResult.provider,
                answer: searchResult.answer ?? null,
                results: searchResult.results,
              },
            },
          });
        } catch (err) {
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                error: err instanceof Error ? err.message : 'External search failed.',
              },
            },
          });
        }
      } else if (call.name === 'getWebContents' && opts.includeExaGetContents) {
        try {
          const rawUrls = Array.isArray(args.urls)
            ? args.urls.filter((u): u is string => typeof u === 'string')
            : [];
          const contentsResult = await fetchExaContents(rawUrls);
          providersUsed.add('Exa Search');
          allSources = mergeSources(allSources, contentsResult.sources);
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                results: contentsResult.results,
                statuses: contentsResult.statuses,
              },
            },
          });
        } catch (err) {
          responseParts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                error: err instanceof Error ? err.message : 'Exa contents extraction failed.',
              },
            },
          });
        }
      } else if (call.name === 'getLiveFxMarketData') {
        const fx = await fetchLiveFxMarketData({
          baseCurrency: typeof args.baseCurrency === 'string' ? args.baseCurrency : 'USD',
          includeCalendar: typeof args.includeCalendar === 'boolean' ? args.includeCalendar : true,
          includeCentralBankNews:
            typeof args.includeCentralBankNews === 'boolean' ? args.includeCentralBankNews : true,
        });
        providersUsed.add('Live FX Feeds & Calendar');
        allSources = mergeSources(allSources, fx.sources);
        responseParts.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: fx.data,
          },
        });
      }
    }

    workingContents.push({ role: 'user', parts: responseParts });
  }

  const finalResponse = await opts.ai.models.generateContent({
    model: opts.model,
    contents: workingContents,
    config: {
      systemInstruction: opts.systemInstruction,
      thinkingConfig: { thinkingLevel: opts.thinkingLevel },
    },
  });

  return {
    reply: finalResponse.text ?? 'No response text generated.',
    sources: allSources,
    providerLabel: Array.from(providersUsed).join(' + ') || 'Live FX Feeds',
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const extProvider = getConfiguredSearchProvider();
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      models: {
        general: 'gemini-4-hydrogen',
        fast: 'gemini-3.1-flash-lite',
        live: 'gemini-3.8-live',
      },
      searchProviders: {
        activeExternal: extProvider,
        tavily: Boolean(process.env.TAVILY_API_KEY?.trim()),
        serper: Boolean(process.env.SERPER_API_KEY?.trim()),
        exa: Boolean(process.env.EXA_API_KEY?.trim()),
        liveFxFeeds: true,
      },
    });
  });

  app.post('/api/chat', async (req: Request, res: Response) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error:
          'GEMINI_API_KEY is not configured. Add it in the Settings > Secrets panel to enable Ledgerwise AI.',
      });
      return;
    }

    const body = (req.body ?? {}) as ChatRequestBody;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      res.status(400).json({ error: 'Chat messages cannot be empty.' });
      return;
    }

    const useSearch = Boolean(body.useSearch);
    const extProvider = getConfiguredSearchProvider();
    const requestedModel =
      body.model === 'gemini-3.1-flash-lite' && (!useSearch || Boolean(extProvider))
        ? 'gemini-3.1-flash-lite'
        : 'gemini-4-hydrogen';

    const thinkingLevel =
      requestedModel === 'gemini-3.1-flash-lite'
        ? ThinkingLevel.MINIMAL
        : body.thinkingMode === 'deep'
          ? ThinkingLevel.XHIGH
          : body.thinkingMode === 'low'
            ? ThinkingLevel.LOW
            : ThinkingLevel.HIGH;

    const systemInstruction = buildSystemInstruction(
      body.persona ?? 'coach',
      body.ledgerContext,
      false,
      useSearch ? extProvider : null
    );

    const contents: Content[] = messages.map((msg) => {
      const parts: Part[] = [];
      if (msg.text && msg.text.trim().length > 0) {
        parts.push({ text: msg.text });
      }
      if (Array.isArray(msg.attachments)) {
        for (const att of msg.attachments) {
          const parsed = parseDataUrl(att.dataUrl);
          if (parsed) {
            parts.push({ inlineData: parsed });
          }
        }
      }
      if (parts.length === 0) {
        parts.push({ text: 'Please review the attached chart screenshot.' });
      }
      return {
        role: msg.role === 'model' ? 'model' : 'user',
        parts,
      };
    });

    try {
      const ai = createGeminiClient(apiKey);

      if (!useSearch) {
        const response = await ai.models.generateContent({
          model: requestedModel,
          contents,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel },
          },
        });
        res.json({
          reply: response.text ?? 'No response text generated.',
          modelUsed: requestedModel,
          searchUsed: false,
          sources: [],
          searchQueries: [],
        });
        return;
      }

      // If an external search key (Exa, Tavily, or Serper) is configured, run tool-augmented search + live FX feeds
      if (extProvider) {
        const result = await runToolAugmentedChat({
          ai,
          model: requestedModel,
          contents,
          systemInstruction,
          thinkingLevel,
          includeExternalWebSearch: true,
          includeExaGetContents: extProvider === 'exa',
        });
        res.json({
          reply: result.reply,
          modelUsed: requestedModel,
          searchUsed: true,
          searchProvider: result.providerLabel,
          sources: result.sources,
          searchQueries: [],
        });
        return;
      }

      // Otherwise try Google Search grounding first; if quota-blocked on free tier, gracefully use keyless live FX rates, calendar & central bank RSS feeds
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: thinkingLevel === ThinkingLevel.MINIMAL ? ThinkingLevel.LOW : thinkingLevel },
            tools: [{ googleSearch: {} }],
          },
        });

        const groundingMeta = response.candidates?.[0]?.groundingMetadata;
        const rawChunks = groundingMeta?.groundingChunks ?? [];
        const seenUris = new Set<string>();
        const sources: GroundingSource[] = [];
        for (const chunk of rawChunks) {
          const uri = chunk.web?.uri;
          const title = chunk.web?.title;
          if (uri && !seenUris.has(uri)) {
            seenUris.add(uri);
            sources.push({ title: title || uri, uri });
          }
        }

        res.json({
          reply: response.text ?? 'No response text generated.',
          modelUsed: 'gemini-4-hydrogen',
          searchUsed: true,
          searchProvider: 'Google Search',
          sources,
          searchQueries: Array.isArray(groundingMeta?.webSearchQueries)
            ? groundingMeta.webSearchQueries
            : [],
        });
      } catch (googleSearchErr: unknown) {
        const parsedErr = extractFriendlyError(googleSearchErr);
        if (parsedErr.status !== 429) {
          throw googleSearchErr;
        }
        const fallbackResult = await runToolAugmentedChat({
          ai,
          model: requestedModel,
          contents,
          systemInstruction: `${systemInstruction}\n\nNote: General Google Search is unavailable on this free-tier key, so you have access to live FX spot rates, the economic calendar, and Fed/ECB central bank RSS feeds via getLiveFxMarketData. If the user asks about a general topic outside live FX rates/calendar/Fed/ECB, answer what you can from those feeds and briefly note they can add a free TAVILY_API_KEY, SERPER_API_KEY, or EXA_API_KEY in Settings > Secrets for full open-web search.`,
          thinkingLevel,
          includeExternalWebSearch: false,
        });
        res.json({
          reply: fallbackResult.reply,
          modelUsed: requestedModel,
          searchUsed: true,
          searchProvider: fallbackResult.providerLabel,
          sources: fallbackResult.sources,
          searchQueries: [],
        });
      }
    } catch (err: unknown) {
      const errStr = String(err instanceof Error ? err.message : err);
      const isHighDemandOrOverload =
        /high demand|overloaded|RESOURCE_EXHAUSTED|UNAVAILABLE|503|429|quota/i.test(errStr);

      if (requestedModel !== 'gemini-3.1-flash-lite' && isHighDemandOrOverload) {
        console.warn(
          `[Gemini Auto-Fallback] ${requestedModel} high demand/busy. Falling back to gemini-3.1-flash-lite...`
        );
        try {
          const ai = createGeminiClient(apiKey);
          const fallbackResp = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents,
            config: {
              systemInstruction,
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            },
          });
          res.json({
            reply: fallbackResp.text ?? 'No response text generated.',
            modelUsed: 'gemini-3.1-flash-lite (high-demand fallback)',
            searchUsed: false,
            sources: [],
            searchQueries: [],
          });
          return;
        } catch {
          // If fallback fails, proceed to return friendly error
        }
      }

      const { status, message } = extractFriendlyError(err);
      res.status(status).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const candidateDirs = [
      path.join(__dirname, 'dist'),
      path.join(process.cwd(), 'dist'),
      __dirname,
    ];
    const distDir = candidateDirs.find((d) => fs.existsSync(path.join(d, 'index.html'))) || candidateDirs[0];
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = request.url || '';
    if (reqUrl.startsWith('/ws/live')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (clientWs: WebSocket) => {
    let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let isClosing = false;

    const safeSend = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const cleanupSession = () => {
      if (isClosing) return;
      isClosing = true;
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          // ignore close errors
        }
        liveSession = null;
      }
    };

    clientWs.on('message', async (raw) => {
      let msg: {
        type?: string;
        voiceName?: string;
        persona?: string;
        ledgerContext?: string;
        audio?: string;
        text?: string;
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        safeSend({ type: 'error', error: 'Invalid WebSocket JSON payload.' });
        return;
      }

      if (msg.type === 'start') {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          safeSend({
            type: 'error',
            error:
              'GEMINI_API_KEY is not configured. Add it in Settings > Secrets to use Live Voice.',
          });
          clientWs.close();
          return;
        }

        if (liveSession) {
          try {
            liveSession.close();
          } catch {
            // ignore
          }
          liveSession = null;
        }

        const allowedVoices = new Set(['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir']);
        const voiceName =
          msg.voiceName && allowedVoices.has(msg.voiceName) ? msg.voiceName : 'Zephyr';

        const systemInstruction = buildSystemInstruction(
          msg.persona ?? 'coach',
          msg.ledgerContext,
          true
        );

        try {
          const ai = createGeminiClient(apiKey);
          liveSession = await ai.live.connect({
            model: 'gemini-3.8-live',
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction,
            },
            callbacks: {
              onopen: () => {
                safeSend({ type: 'ready', voiceName, model: 'gemini-3.8-live' });
              },
              onmessage: (message: LiveServerMessage) => {
                const sc = message.serverContent;
                if (sc?.inputTranscription?.text) {
                  safeSend({
                    type: 'inputTranscript',
                    text: sc.inputTranscription.text,
                  });
                }
                if (sc?.outputTranscription?.text) {
                  safeSend({
                    type: 'outputTranscript',
                    text: sc.outputTranscription.text,
                  });
                }
                for (const part of sc?.modelTurn?.parts ?? []) {
                  if (part.inlineData?.data) {
                    safeSend({ type: 'audio', data: part.inlineData.data });
                  }
                }
                if (sc?.interrupted) {
                  safeSend({ type: 'interrupted' });
                }
                if (sc?.turnComplete) {
                  safeSend({ type: 'turnComplete' });
                }
              },
              onerror: (err: unknown) => {
                const { message } = extractFriendlyError(err);
                safeSend({ type: 'error', error: message });
              },
              onclose: () => {
                safeSend({ type: 'closed' });
              },
            },
          });
        } catch (err: unknown) {
          const { message } = extractFriendlyError(err);
          safeSend({ type: 'error', error: message });
        }
        return;
      }

      if (msg.type === 'audio' && msg.audio && liveSession) {
        liveSession.sendRealtimeInput({
          audio: {
            data: msg.audio,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
        return;
      }

      if (msg.type === 'text' && msg.text && liveSession) {
        liveSession.sendRealtimeInput({
          text: msg.text,
        });
        return;
      }

      if (msg.type === 'stop') {
        cleanupSession();
      }
    });

    clientWs.on('close', cleanupSession);
    clientWs.on('error', cleanupSession);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Ledgerwise FX + Gemini AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
