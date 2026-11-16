import { GoogleGenAI, ThinkingLevel } from '@google/genai';

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

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: 'GEMINI_API_KEY environment variable is missing on this deployment.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = (await req.json()) as ChatRequestBody;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No messages provided in request body.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const persona = body.persona && PERSONA_INSTRUCTIONS[body.persona] ? body.persona : 'coach';
    const personaPrompt = PERSONA_INSTRUCTIONS[persona];
    const systemInstruction = body.ledgerContext
      ? `${personaPrompt}\n\n=== LIVE TRADER LEDGER CONTEXT ===\n${body.ledgerContext}`
      : personaPrompt;

    const requestedModel =
      body.model === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';

    const thinkingLevel =
      requestedModel === 'gemini-3.1-flash-lite'
        ? ThinkingLevel.MINIMAL
        : body.thinkingMode === 'low'
          ? ThinkingLevel.LOW
          : body.thinkingMode === 'deep'
            ? ThinkingLevel.XHIGH
            : ThinkingLevel.HIGH;

    const contents = messages.map((m) => {
      const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
      if (m.text) parts.push({ text: m.text });
      for (const att of m.attachments ?? []) {
        const parsed = parseDataUrl(att.dataUrl);
        if (parsed) parts.push({ inlineData: parsed });
      }
      return {
        role: m.role === 'model' ? 'model' : 'user',
        parts,
      };
    });

    let response;
    let actualModel = requestedModel;

    try {
      response = await ai.models.generateContent({
        model: requestedModel,
        contents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel },
        },
      });
    } catch (modelErr: unknown) {
      const errStr = String(modelErr instanceof Error ? modelErr.message : modelErr);
      const isHighDemandOrOverload =
        /high demand|overloaded|RESOURCE_EXHAUSTED|UNAVAILABLE|503|429|quota/i.test(errStr);

      if (requestedModel !== 'gemini-3.1-flash-lite' && isHighDemandOrOverload) {
        actualModel = 'gemini-3.1-flash-lite (high-demand fallback)';
        response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          },
        });
      } else {
        throw modelErr;
      }
    }

    return new Response(
      JSON.stringify({
        reply: response.text ?? 'No response generated.',
        modelUsed: actualModel,
        searchUsed: false,
        sources: [],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown serverless error occurred.';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
