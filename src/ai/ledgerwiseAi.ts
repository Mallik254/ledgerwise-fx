import { buildLedgerContextString, buildQuickPrompts } from './contextBuilder';
import { renderMarkdown } from './markdown';
import { processImageFile } from '../utils/imageUtils';
import { GeminiLiveVoiceClient } from './voiceClient';
import type {
  AiAttachment,
  AiChatMessage,
  AiModel,
  AiPersona,
  AiThinkingMode,
  ContextSlices,
  GroundingSource,
  LedgerSnapshot,
  LiveVoiceName,
  VoiceTranscriptEntry,
} from './types';

const CHAT_STORAGE_KEY = 'ledgerwise_fx_ai_thread_v1';
const PREF_STORAGE_KEY = 'ledgerwise_fx_ai_prefs_v1';

interface AiPrefs {
  persona: AiPersona;
  model: AiModel;
  thinkingMode: AiThinkingMode;
  useSearch: boolean;
  voiceName: LiveVoiceName;
  slices: ContextSlices;
}

const DEFAULT_PREFS: AiPrefs = {
  persona: 'coach',
  model: 'gemini-4-hydrogen',
  thinkingMode: 'high',
  useSearch: false,
  voiceName: 'Zephyr',
  slices: {
    accounts: true,
    trades: true,
    cashflow: true,
    psychology: true,
  },
};

const PERSONAS: Array<{ id: AiPersona; label: string; hint: string }> = [
  { id: 'coach', label: 'Execution coach', hint: 'Setups, checklist grades, Setup Watch & Fear cards' },
  { id: 'risk', label: 'Prop & risk auditor', hint: 'Daily loss room, max DD buffers, risk ladder & charter' },
  { id: 'cfo', label: 'Finance CFO', hint: 'Payout waterfall, tax reserve, USD/KES cashflow & runway' },
  { id: 'macro', label: 'Macro & news', hint: 'Live FX catalysts, central banks & session risk' },
];

const VOICES: LiveVoiceName[] = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];

function escapeAttr(raw: string): string {
  return raw.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function nowTimeLabel(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function defaultWelcomeMessage(): AiChatMessage {
  return {
    id: 'ai_welcome',
    role: 'model',
    text: 'Ledgerwise AI Desk is connected to your live ledger. Ask about prop-firm drawdown buffers, trade execution quality, payout allocation, or enable **Web search** for live FX macro and news drivers.',
    timestamp: 'Ready',
    modelUsed: 'gemini-4-hydrogen',
  };
}

function sanitizePrefs(parsed?: Partial<AiPrefs> | null): AiPrefs {
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_PREFS, slices: { ...DEFAULT_PREFS.slices } };
  }
  return {
    persona: parsed.persona && ['coach', 'risk', 'cfo', 'macro'].includes(parsed.persona) ? parsed.persona : DEFAULT_PREFS.persona,
    model: parsed.model === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen',
    thinkingMode: parsed.thinkingMode && ['low', 'high', 'deep'].includes(parsed.thinkingMode) ? parsed.thinkingMode : 'high',
    useSearch: Boolean(parsed.useSearch),
    voiceName: parsed.voiceName && VOICES.includes(parsed.voiceName) ? parsed.voiceName : 'Zephyr',
    slices: {
      accounts: parsed.slices?.accounts ?? true,
      trades: parsed.slices?.trades ?? true,
      cashflow: parsed.slices?.cashflow ?? true,
      psychology: parsed.slices?.psychology ?? true,
    },
  };
}

function loadPrefs(): AiPrefs {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return sanitizePrefs(null);
    return sanitizePrefs(JSON.parse(raw) as Partial<AiPrefs>);
  } catch {
    return sanitizePrefs(null);
  }
}

function loadMessages(): AiChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [defaultWelcomeMessage()];
    const parsed = JSON.parse(raw) as AiChatMessage[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [defaultWelcomeMessage()];
  } catch {
    return [defaultWelcomeMessage()];
  }
}

class LedgerwiseAiController {
  private prefs: AiPrefs = loadPrefs();
  private messages: AiChatMessage[] = loadMessages();
  private attachments: AiAttachment[] = [];
  private draft = '';
  private isSending = false;
  private errorText: string | null = null;
  private activeTab: 'chat' | 'voice' = 'chat';
  private drawerOpen = false;
  private showLedgerShotPicker = false;

  // Voice state
  private voiceStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private voiceStatusDetail = 'Ready to start a real-time voice coaching session.';
  private voiceMuted = false;
  private transcripts: VoiceTranscriptEntry[] = [];
  private inLevel = 0;
  private outLevel = 0;
  private voiceClient: GeminiLiveVoiceClient;
  private mounted = false;
  private searchProviderActive: 'tavily' | 'serper' | 'exa' | null = null;

  constructor() {
    this.voiceClient = new GeminiLiveVoiceClient({
      onStatus: (status, detail) => {
        this.voiceStatus = status;
        if (detail) this.voiceStatusDetail = detail;
        if (status === 'disconnected') {
          this.voiceMuted = false;
        }
        this.refreshUi();
      },
      onInputTranscript: (text) => {
        this.appendTranscript('you', text);
      },
      onOutputTranscript: (text) => {
        this.appendTranscript('ai', text);
      },
      onTurnComplete: () => {
        // Keep transcripts cleanly separated between turns
      },
      onInterrupted: () => {
        this.appendTranscript('system', 'Playback interrupted — listening.');
      },
      onLevel: (inLv, outLv) => {
        this.inLevel = inLv;
        this.outLevel = outLv;
        this.drawVoiceVisualizer();
      },
    });
    this.syncFromCloud(false);
    void this.loadHealthCapabilities();
  }

  private async loadHealthCapabilities() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return;
      const data = (await res.json()) as {
        searchProviders?: { activeExternal?: 'tavily' | 'serper' | 'exa' | null };
      };
      this.searchProviderActive = data.searchProviders?.activeExternal ?? null;
      this.refreshUi();
    } catch {
      // ignore offline/startup race
    }
  }

  private appendTranscript(speaker: 'you' | 'ai' | 'system', text: string) {
    const cleaned = text.trim();
    if (!cleaned) return;
    const last = this.transcripts[this.transcripts.length - 1];
    if (last && last.speaker === speaker && speaker !== 'system' && Date.now() - Number(last.id.split('_')[1] || 0) < 6000) {
      last.text = `${last.text} ${cleaned}`.replace(/\s+/g, ' ').trim();
    } else {
      this.transcripts.push({
        id: `vt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        speaker,
        text: cleaned,
        at: nowTimeLabel(),
      });
      if (this.transcripts.length > 60) {
        this.transcripts = this.transcripts.slice(-60);
      }
    }
    this.refreshVoiceTranscriptDom();
  }

  private pushAiStateToCloud() {
    const bridge = window.__LW_BRIDGE__;
    if (!bridge?.saveAiState) return;
    const cloudMessages = this.messages
      .filter((m) => m.id !== 'ai_welcome')
      .slice(-30)
      .map((m) => ({
        ...m,
        attachments: undefined,
      }));
    bridge.saveAiState({
      prefs: this.prefs,
      messages: cloudMessages,
    });
  }

  syncFromCloud(shouldRefresh = true) {
    const bridge = window.__LW_BRIDGE__;
    const status = bridge?.getCloudStatus?.();
    if (!bridge || !status) return;

    if (!status.signedIn) {
      if (status.enabled) {
        // Signed out while cloud auth is active -> clear thread so next user never sees stale data
        this.messages = [defaultWelcomeMessage()];
        this.prefs = sanitizePrefs(null);
      } else {
        // Local preview mode
        this.prefs = loadPrefs();
        this.messages = loadMessages();
      }
      if (shouldRefresh) this.refreshUi();
      return;
    }

    const cloudAi = bridge.getAiState?.();
    if (cloudAi) {
      this.prefs = cloudAi.prefs ? sanitizePrefs(cloudAi.prefs) : sanitizePrefs(null);
      const msgs = Array.isArray(cloudAi.messages) && cloudAi.messages.length > 0
        ? [defaultWelcomeMessage(), ...cloudAi.messages.filter((m) => m.id !== 'ai_welcome')]
        : [defaultWelcomeMessage()];
      this.messages = msgs;
      try {
        localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(this.prefs));
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(this.messages.slice(-30)));
      } catch {
        // ignore storage quota errors
      }
    }
    if (shouldRefresh) this.refreshUi();
  }

  private savePrefs() {
    try {
      localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      // ignore storage errors
    }
    this.pushAiStateToCloud();
  }

  private saveMessages() {
    try {
      // Store up to last 30 messages without oversized inline image blobs if storage is tight
      const compact = this.messages.slice(-30).map((m) => ({
        ...m,
        attachments: m.attachments?.slice(0, 2),
      }));
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(compact));
    } catch {
      try {
        const textOnly = this.messages.slice(-30).map((m) => ({
          ...m,
          attachments: undefined,
        }));
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(textOnly));
      } catch {
        // ignore quota errors
      }
    }
    this.pushAiStateToCloud();
  }

  private getSnapshot(): LedgerSnapshot | null {
    return window.__LW_BRIDGE__ ? window.__LW_BRIDGE__.getSnapshot() : null;
  }

  private getContextString(): string {
    return buildLedgerContextString(this.getSnapshot(), this.prefs.slices);
  }

  mountStyles() {
    if (this.mounted) return;
    this.mounted = true;
    const style = document.createElement('style');
    style.id = 'lw-ai-styles';
    style.textContent = `
      .ai-workspace { display: grid; grid-template-columns: minmax(0, 1.85fr) minmax(300px, 1fr); gap: 14px; align-items: start; }
      @media (max-width: 1080px) { .ai-workspace { grid-template-columns: 1fr; } }

      .ai-panel {
        display: flex;
        flex-direction: column;
        height: 620px;
        min-height: 420px;
        max-height: calc(100vh - 160px);
        padding: 0;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--card);
      }
      .ai-landing-hero {
        margin-bottom: 14px;
        padding: 16px 18px;
        border-radius: 14px;
        border: 1px solid rgba(95, 227, 179, 0.22);
        background: linear-gradient(135deg, rgba(95, 227, 179, 0.06) 0%, rgba(125, 184, 255, 0.04) 50%, rgba(21, 22, 26, 0.95) 100%);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
        display: flex; flex-direction: column; gap: 14px;
      }
      .ai-landing-stats {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;
      }
      .ai-hero-stat {
        display: flex; flex-direction: column; gap: 3px;
        padding: 10px 14px; border-radius: 10px;
        background: var(--card-soft); border: 1px solid var(--line);
      }
      .ai-hero-k { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
      .ai-hero-v { font-size: 17px; font-weight: 700; color: var(--text); font-family: var(--mono); }
      .ai-hero-v.mint { color: var(--mint); }
      .ai-hero-v.sky { color: var(--sky); }
      .ai-hero-v.amber { color: var(--amber); }
      .ai-hero-sub { font-size: 11px; color: var(--muted-2); }
      .ai-landing-presets {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px;
      }
      .ai-landing-preset-btn {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 13px; border-radius: 10px;
        background: var(--inset); border: 1px solid var(--line-2);
        color: var(--text); text-align: left; cursor: pointer;
        transition: border-color .15s, background .15s, transform .1s;
      }
      .ai-landing-preset-btn:hover {
        border-color: var(--mint-line); background: var(--card-2); transform: translateY(-1px);
      }
      .ai-preset-icon { font-size: 18px; line-height: 1; }
      .ai-preset-title { font-size: 12px; font-weight: 650; color: var(--text); }
      .ai-preset-desc { font-size: 10.5px; color: var(--muted); margin-top: 1px; }
      .ai-toolbar {
        padding: 12px 18px;
        border-bottom: 1px solid var(--line);
        background: var(--card-soft);
        display: flex; flex-direction: column; gap: 9px;
        flex-shrink: 0;
      }
      .ai-toolbar-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .ai-persona-group { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
      .ai-pill-btn {
        height: 30px; padding: 0 11px; border-radius: 8px;
        border: 1px solid var(--line); background: var(--card);
        color: var(--muted); font-size: 11.5px; font-weight: 600;
        transition: background .15s, color .15s, border-color .15s;
        white-space: nowrap;
      }
      .ai-pill-btn:hover { color: var(--text); border-color: var(--line-2); }
      .ai-pill-btn.active { background: var(--mint-soft); color: var(--mint); border-color: var(--mint-line); }

      .ai-controls-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ai-select-compact {
        height: 30px; font-size: 11.5px; padding: 0 28px 0 10px;
        border-radius: 8px; border: 1px solid var(--line-2);
        background-color: var(--inset); color: var(--text);
        font-family: var(--mono);
      }
      .ai-search-toggle {
        display: inline-flex; align-items: center; gap: 6px;
        height: 30px; padding: 0 10px; border-radius: 8px;
        border: 1px solid var(--line-2); background: var(--inset);
        color: var(--muted); font-size: 11.5px; font-weight: 600;
        transition: background .15s, color .15s, border-color .15s;
        white-space: nowrap;
      }
      .ai-search-toggle:hover { color: var(--text); border-color: var(--line-strong); }
      .ai-search-toggle.active { background: var(--sky-soft); color: var(--sky); border-color: var(--sky-line); }

      .ai-thread {
        flex: 1 1 0%; overflow-y: auto; padding: 18px;
        display: flex; flex-direction: column; gap: 14px;
        min-height: 0;
        overscroll-behavior: contain;
      }
      .ai-msg { display: flex; flex-direction: column; gap: 5px; max-width: 88%; }
      .ai-msg.user { align-self: flex-end; align-items: flex-end; }
      .ai-msg.model { align-self: flex-start; align-items: flex-start; width: 100%; max-width: 92%; }

      .ai-bubble {
        padding: 13px 16px; border-radius: 14px;
        font-size: 13px; line-height: 1.6;
        border: 1px solid var(--line);
      }
      .ai-msg.user .ai-bubble {
        background: var(--mint-soft);
        border-color: var(--mint-line);
        color: var(--text);
      }
      .ai-msg.model .ai-bubble {
        background: var(--card-2);
        border-color: var(--line);
        color: var(--prose);
        width: 100%;
      }
      .ai-msg-meta {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        font-family: var(--mono); font-size: 10px; color: var(--muted-2);
        padding: 0 2px;
      }
      .ai-msg-copy {
        background: none; border: 0; padding: 0 4px; color: var(--muted-2);
        font-family: var(--mono); font-size: 10px; cursor: pointer;
      }
      .ai-msg-copy:hover { color: var(--mint); }

      .ai-md-h { margin: 10px 0 4px; font-size: 13.5px; font-weight: 700; color: var(--text); letter-spacing: -0.015em; }
      .ai-md-h:first-child { margin-top: 0; }
      .ai-md-p { margin: 0 0 8px; }
      .ai-md-p:last-child { margin-bottom: 0; }
      .ai-md-list { margin: 4px 0 8px; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
      .ai-md-list:last-child { margin-bottom: 0; }
      .ai-inline-code {
        font-family: var(--mono); font-size: 11.5px;
        background: var(--inset); border: 1px solid var(--line);
        padding: 1px 5px; border-radius: 5px; color: var(--mint);
      }
      .ai-code-block {
        margin: 8px 0; padding: 10px 12px; border-radius: 10px;
        background: var(--inset); border: 1px solid var(--line);
        font-family: var(--mono); font-size: 11.5px; overflow-x: auto; color: var(--text-2);
      }

      .ai-sources {
        margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line);
        display: flex; flex-direction: column; gap: 6px;
      }
      .ai-sources-head {
        font-family: var(--mono); font-size: 9.5px; text-transform: uppercase;
        letter-spacing: 0.09em; color: var(--sky);
      }
      .ai-sources-list { display: flex; flex-wrap: wrap; gap: 6px; }
      .ai-source-link {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 9px; border-radius: 7px;
        border: 1px solid var(--sky-line); background: var(--sky-soft);
        color: var(--sky); font-size: 11px; max-width: 260px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ai-source-link:hover { filter: brightness(1.1); text-decoration: underline; }

      .ai-att-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
      .ai-att-thumb {
        position: relative; width: 78px; height: 54px; border-radius: 8px;
        overflow: hidden; border: 1px solid var(--line-2); background: var(--frame);
      }
      .ai-att-thumb img { width: 100%; height: 100%; object-fit: cover; }
      .ai-att-remove {
        position: absolute; top: 3px; right: 3px; width: 18px; height: 18px;
        border-radius: 50%; border: 0; background: var(--scrim); color: #fff;
        font-size: 11px; line-height: 1; display: grid; place-items: center;
      }

      .ai-quick-row {
        padding: 0 18px 10px; display: flex; flex-wrap: wrap; gap: 6px;
      }
      .ai-quick-btn {
        padding: 5px 10px; border-radius: 8px;
        border: 1px solid var(--line); background: var(--card-soft);
        color: var(--text-2); font-size: 11px; font-weight: 550;
        transition: border-color .15s, background .15s, color .15s;
      }
      .ai-quick-btn:hover { border-color: var(--mint-line); color: var(--text); background: var(--card-2); }

      .ai-composer {
        padding: 12px 16px 14px;
        border-top: 1px solid var(--line);
        background: var(--card-soft);
      }
      .ai-composer-bar { display: flex; align-items: flex-end; gap: 8px; }
      .ai-composer-bar textarea { min-height: 44px; max-height: 140px; padding: 10px 12px; }
      .ai-shot-picker {
        margin-bottom: 10px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid var(--line-2); background: var(--inset);
      }
      .ai-shot-picker-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; max-height: 120px; overflow-y: auto; }

      .ai-error-box {
        margin: 0 18px 10px; padding: 10px 13px; border-radius: 10px;
        border: 1px solid var(--rose-line); background: var(--rose-soft);
        color: var(--rose-text); font-size: 12px;
      }
      .ai-thinking-bubble {
        display: inline-flex; align-items: center; gap: 9px;
        padding: 10px 14px; border-radius: 12px;
        border: 1px solid var(--line); background: var(--card-2);
        font-family: var(--mono); font-size: 11.5px; color: var(--mint);
      }
      .ai-pulse {
        width: 7px; height: 7px; border-radius: 50%; background: var(--mint);
        animation: aiPulse 1.2s ease-in-out infinite;
      }
      @keyframes aiPulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.15); } }

      /* Voice Panel */
      .ai-voice-stage {
        padding: 20px 18px; display: flex; flex-direction: column; gap: 14px; flex: 1; min-height: 0;
      }
      .ai-voice-visualizer-card {
        padding: 18px; border-radius: 14px; border: 1px solid var(--line);
        background: var(--inset); display: flex; flex-direction: column; gap: 14px;
      }
      .ai-voice-canvas { width: 100%; height: 76px; display: block; border-radius: 8px; }
      .ai-voice-controls { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
      .ai-transcript-box {
        flex: 1; min-height: 180px; max-height: 300px; overflow-y: auto;
        padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
        background: var(--card-soft); display: flex; flex-direction: column; gap: 9px;
      }
      .ai-vt-row { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.5; }
      .ai-vt-speaker {
        font-family: var(--mono); font-size: 10px; font-weight: 650;
        text-transform: uppercase; min-width: 54px; padding-top: 2px;
      }
      .ai-vt-speaker.you { color: var(--mint); }
      .ai-vt-speaker.ai { color: var(--amber); }
      .ai-vt-speaker.system { color: var(--muted-2); }

      /* Slide-Over Quick Drawer */
      .ai-drawer-backdrop {
        position: fixed; inset: 0; z-index: 90;
        background: var(--scrim); display: flex; justify-content: flex-end;
      }
      .ai-drawer-backdrop[hidden] { display: none; }
      .ai-drawer {
        width: min(450px, 88vw);
        height: 100%;
        height: 100dvh;
        max-height: 100dvh;
        background: var(--modal);
        border-left: 1px solid var(--line-2);
        box-shadow: -10px 0 35px rgba(0, 0, 0, 0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .ai-drawer-head {
        padding: 13px 18px;
        border-bottom: 1px solid var(--line);
        background: var(--card-soft);
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        flex-shrink: 0;
      }
      .ai-drawer .ai-panel {
        max-height: none; min-height: 0; flex: 1 1 0%;
        height: 100%; border: 0; border-radius: 0;
        background: transparent; box-shadow: none;
      }
      .ai-composer {
        flex-shrink: 0;
        padding: 12px 16px;
        border-top: 1px solid var(--line);
        background: var(--card-soft);
      }
    `;
    document.head.appendChild(style);
  }

  private renderMessagesHtml(): string {
    return this.messages
      .map((m) => {
        const isUser = m.role === 'user';
        const attsHtml =
          m.attachments && m.attachments.length > 0
            ? `<div class="ai-att-row">${m.attachments
                .map(
                  (a) =>
                    `<div class="ai-att-thumb"><img src="${escapeAttr(a.dataUrl)}" alt="${escapeAttr(a.name)}" referrerpolicy="no-referrer"></div>`
                )
                .join('')}</div>`
            : '';

        const sourcesHtml =
          m.sources && m.sources.length > 0
            ? `<div class="ai-sources">
                <div class="ai-sources-head">Grounded web sources (${m.sources.length})</div>
                <div class="ai-sources-list">
                  ${m.sources
                    .map(
                      (s: GroundingSource) =>
                        `<a class="ai-source-link" href="${escapeAttr(s.uri)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(s.title)}">${escapeAttr(s.title)}</a>`
                    )
                    .join('')}
                </div>
              </div>`
            : '';

        const bodyHtml = isUser
          ? `<div class="ai-md-p" style="white-space:pre-wrap">${escapeAttr(m.text)}</div>`
          : renderMarkdown(m.text);

        return `
          <div class="ai-msg ${isUser ? 'user' : 'model'}">
            <div class="ai-bubble">
              ${attsHtml}
              ${bodyHtml}
              ${sourcesHtml}
            </div>
            <div class="ai-msg-meta">
              <span>${isUser ? 'You' : escapeAttr(m.modelUsed || 'gemini-4-hydrogen')}</span>
              ${m.searchUsed ? `<span>· ${escapeAttr(m.searchProvider || 'Web Search')}</span>` : ''}
              <span>· ${escapeAttr(m.timestamp)}</span>
              ${!isUser ? `<button type="button" class="ai-msg-copy" data-ai-act="copy" data-msg-id="${escapeAttr(m.id)}">Copy</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  private getSearchBadgeSuffix(): string {
    if (!this.prefs.useSearch) return 'Off';
    if (this.searchProviderActive === 'tavily') return 'On · Tavily';
    if (this.searchProviderActive === 'serper') return 'On · Serper';
    if (this.searchProviderActive === 'exa') return 'On · Exa';
    return 'On · Live FX';
  }

  private renderToolbarHtml(): string {
    const extHint = this.searchProviderActive
      ? `Using ${this.searchProviderActive.toUpperCase()} web search + live FX feeds`
      : 'Uses Live FX spot rates, economic calendar & Fed/ECB feeds (add optional free TAVILY_API_KEY, SERPER_API_KEY, or EXA_API_KEY in Settings > Secrets for full web search)';

    return `
      <div class="ai-toolbar">
        <div class="ai-toolbar-row">
          <div class="ai-persona-group" role="group" aria-label="AI persona">
            ${PERSONAS.map(
              (p) =>
                `<button type="button" class="ai-pill-btn ${this.prefs.persona === p.id ? 'active' : ''}" data-ai-act="set-persona" data-persona="${p.id}" title="${escapeAttr(p.hint)}">${escapeAttr(p.label)}</button>`
            ).join('')}
          </div>
        </div>
        <div class="ai-toolbar-row">
          <div class="ai-controls-right">
            <select class="select ai-select-compact" data-ai-change="model" aria-label="Gemini model">
              <option value="gemini-4-hydrogen"${this.prefs.model === 'gemini-4-hydrogen' ? ' selected' : ''}>gemini-4-hydrogen (General &amp; Reasoning)</option>
              <option value="gemini-3.1-flash-lite"${this.prefs.model === 'gemini-3.1-flash-lite' ? ' selected' : ''}>gemini-3.1-flash-lite (Fast)</option>
            </select>
            ${
              this.prefs.model === 'gemini-4-hydrogen'
                ? `<select class="select ai-select-compact" data-ai-change="thinking" aria-label="Reasoning depth">
                    <option value="low"${this.prefs.thinkingMode === 'low' ? ' selected' : ''}>Thinking: Low</option>
                    <option value="high"${this.prefs.thinkingMode === 'high' ? ' selected' : ''}>Thinking: High</option>
                    <option value="deep"${this.prefs.thinkingMode === 'deep' ? ' selected' : ''}>Thinking: Deep (XHIGH)</option>
                  </select>`
                : ''
            }
          </div>
          <button type="button" class="ai-search-toggle ${this.prefs.useSearch ? 'active' : ''}" data-ai-act="toggle-search" title="${escapeAttr(extHint)}">
            <span>Web search: ${escapeAttr(this.getSearchBadgeSuffix())}</span>
          </button>
        </div>
      </div>
    `;
  }

  private renderChatBodyHtml(scope: 'page' | 'drawer'): string {
    const snap = this.getSnapshot();
    const quickPrompts = buildQuickPrompts(snap);
    const availableShots = snap?.availableShots ?? [];

    const shotPickerHtml =
      this.showLedgerShotPicker && availableShots.length > 0
        ? `<div class="ai-shot-picker">
            <div class="between">
              <span class="tiny muted">Pick a saved Ledgerwise chart picture</span>
              <button type="button" class="btn-link" data-ai-act="toggle-shot-picker" style="font-size:11px">Close</button>
            </div>
            <div class="ai-shot-picker-grid">
              ${availableShots
                .slice(0, 12)
                .map(
                  (s) =>
                    `<button type="button" class="btn btn-sm btn-ghost" data-ai-act="attach-ledger-shot" data-shot-id="${escapeAttr(s.id)}" data-shot-label="${escapeAttr(s.label)}">${escapeAttr(s.label)}</button>`
                )
                .join('')}
            </div>
          </div>`
        : '';

    const attsPreview =
      this.attachments.length > 0
        ? `<div class="ai-att-row">${this.attachments
            .map(
              (a, i) => `
              <div class="ai-att-thumb">
                <img src="${escapeAttr(a.dataUrl)}" alt="${escapeAttr(a.name)}" referrerpolicy="no-referrer">
                <button type="button" class="ai-att-remove" data-ai-act="remove-att" data-idx="${i}" aria-label="Remove image">×</button>
              </div>`
            )
            .join('')}</div>`
        : '';

    return `
      ${this.renderToolbarHtml()}
      <div class="ai-thread" data-ai-thread="${scope}">
        ${this.renderMessagesHtml()}
        ${
          this.isSending
            ? `<div><div class="ai-thinking-bubble"><span class="ai-pulse"></span><span>${this.prefs.useSearch ? 'Searching web & reading your ledger…' : 'Analyzing your ledger…'}</span></div></div>`
            : ''
        }
      </div>
      ${this.errorText ? `<div class="ai-error-box">${escapeAttr(this.errorText)}</div>` : ''}
      ${
        this.messages.length <= 2 && !this.isSending
          ? `<div class="ai-quick-row">
              ${quickPrompts
                .map(
                  (q, idx) =>
                    `<button type="button" class="ai-quick-btn" data-ai-act="quick-prompt" data-qidx="${idx}">${escapeAttr(q.label)}</button>`
                )
                .join('')}
            </div>`
          : ''
      }
      <div class="ai-composer">
        ${shotPickerHtml}
        ${attsPreview}
        <div class="ai-composer-bar">
          <input type="file" accept="image/*" multiple data-ai-file="${scope}" class="visually-hidden">
          <button type="button" class="btn btn-ghost btn-sm" style="height:40px" data-ai-act="pick-file" data-scope="${scope}" title="Upload chart screenshot">Image</button>
          ${
            availableShots.length > 0
              ? `<button type="button" class="btn btn-ghost btn-sm" style="height:40px" data-ai-act="toggle-shot-picker" title="Attach from saved trade or watch pictures">Charts (${availableShots.length})</button>`
              : ''
          }
          <textarea class="textarea" data-ai-input="${scope}" rows="1" placeholder="Ask about your trades, prop buffers, cashflow, or paste (Ctrl+V) a chart…">${escapeAttr(this.draft)}</textarea>
          <button type="button" class="btn btn-primary" style="height:40px" data-ai-act="send" data-scope="${scope}" ${this.isSending ? 'disabled' : ''}>Send</button>
        </div>
      </div>
    `;
  }

  private renderVoiceBodyHtml(): string {
    const isConnected = this.voiceStatus === 'connected';
    const isConnecting = this.voiceStatus === 'connecting';

    const statusBadgeClass =
      this.voiceStatus === 'connected'
        ? 'badge-mint'
        : this.voiceStatus === 'connecting'
          ? 'badge-amber'
          : this.voiceStatus === 'error'
            ? 'badge-rose'
            : 'badge-muted';

    const transcriptHtml =
      this.transcripts.length > 0
        ? this.transcripts
            .map(
              (t) => `
              <div class="ai-vt-row">
                <span class="ai-vt-speaker ${t.speaker}">${t.speaker === 'you' ? 'You' : t.speaker === 'ai' ? 'Gemini' : 'Desk'}</span>
                <span style="color:var(--text-2);flex:1">${escapeAttr(t.text)}</span>
                <span class="mono tiny muted">${escapeAttr(t.at)}</span>
              </div>`
            )
            .join('')
        : '<div class="tiny muted">Start a live voice session to talk hands-free with your trading coach. Your active ledger balances, prop rules, and recent trades are shared automatically.</div>';

    return `
      <div class="ai-toolbar">
        <div class="ai-toolbar-row">
          <div class="ai-persona-group">
            ${PERSONAS.map(
              (p) =>
                `<button type="button" class="ai-pill-btn ${this.prefs.persona === p.id ? 'active' : ''}" data-ai-act="set-persona" data-persona="${p.id}" ${isConnected || isConnecting ? 'disabled' : ''}>${escapeAttr(p.label)}</button>`
            ).join('')}
          </div>
          <select class="select ai-select-compact" data-ai-change="voice" aria-label="Voice preset" ${isConnected || isConnecting ? 'disabled' : ''}>
            ${VOICES.map((v) => `<option value="${v}"${this.prefs.voiceName === v ? ' selected' : ''}>Voice: ${v}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="ai-voice-stage">
        <div class="ai-voice-visualizer-card">
          <div class="between wrap">
            <div>
              <div class="card-title-sm">Gemini Live Audio · <span class="mono" style="font-size:12px">gemini-3.8-live</span></div>
              <div class="tiny muted" style="margin-top:3px">${escapeAttr(this.voiceStatusDetail)}</div>
            </div>
            <span class="badge ${statusBadgeClass}">${escapeAttr(this.voiceStatus)}</span>
          </div>
          <canvas class="ai-voice-canvas" id="ai-voice-canvas" width="640" height="76"></canvas>
          <div class="ai-voice-controls">
            ${
              !isConnected && !isConnecting
                ? `<button type="button" class="btn btn-primary" data-ai-act="voice-start">Start voice session</button>`
                : `<button type="button" class="btn btn-danger" data-ai-act="voice-stop">End session</button>`
            }
            ${
              isConnected
                ? `<button type="button" class="btn btn-ghost" data-ai-act="voice-mute">${this.voiceMuted ? 'Unmute mic' : 'Mute mic'}</button>
                   <button type="button" class="btn btn-ghost btn-sm" data-ai-act="voice-nudge" data-topic="Audit my prop accounts and daily loss room right now.">Nudge: DD Audit</button>
                   <button type="button" class="btn btn-ghost btn-sm" data-ai-act="voice-nudge" data-topic="Debrief my last 3 trades and what I should tighten.">Nudge: Trade Debrief</button>`
                : ''
            }
          </div>
        </div>

        <div class="between">
          <span class="tiny muted mono" style="text-transform:uppercase;letter-spacing:0.08em">Live transcript</span>
          ${this.transcripts.length > 0 ? `<button type="button" class="btn-link" data-ai-act="voice-clear" style="font-size:11px">Clear</button>` : ''}
        </div>
        <div class="ai-transcript-box" id="ai-voice-transcripts">${transcriptHtml}</div>
      </div>
    `;
  }

  private renderContextSidebarHtml(): string {
    const snap = this.getSnapshot();
    const s = this.prefs.slices;

    const sliceToggle = (key: keyof ContextSlices, label: string, sub: string) => `
      <div class="side-list-row">
        <div class="k" style="flex-direction:column;align-items:flex-start;gap:2px">
          <span style="color:var(--text);font-weight:600">${label}</span>
          <span class="tiny muted">${sub}</span>
        </div>
        <label class="switch">
          <input type="checkbox" data-ai-slice="${key}" ${s[key] ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>`;

    return `
      <div class="stack">
        <section class="card">
          <div class="card-head tight">
            <div>
              <div class="card-title">Live ledger context</div>
              <div class="card-sub">Sent with every prompt and voice session.</div>
            </div>
            <span class="badge badge-mint no-dot">${snap ? `${snap.healthScore}/100` : 'Ready'}</span>
          </div>
          <div class="side-list">
            <div class="side-list-row"><span class="k">Total equity</span><span class="v">${escapeAttr(snap?.totalEquityFormatted || '$0.00')}</span></div>
            <div class="side-list-row"><span class="k">Live trades</span><span class="v">${snap?.tradeCount ?? 0} (${snap?.winRatePct != null ? `${snap.winRatePct.toFixed(0)}% WR` : '—'})</span></div>
            <div class="side-list-row"><span class="k">Expected payouts</span><span class="v pos">${escapeAttr(snap?.expectedPayoutFormatted || '$0.00')}</span></div>
            <div class="side-list-row"><span class="k">Household runway</span><span class="v">${snap?.runwayMonths != null ? `${snap.runwayMonths.toFixed(1)} mo` : '—'}</span></div>
            <div class="side-list-row"><span class="k">Armed watches</span><span class="v">${snap?.openWatchCount ?? 0}</span></div>
            <div class="side-list-row"><span class="k">Cloud sync</span><span class="v">${escapeAttr(window.__LW_BRIDGE__?.getCloudStatus?.().signedIn ? 'Supabase Cloud' : 'Local browser')}</span></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head tight">
            <div>
              <div class="card-title">Shared data slices</div>
              <div class="card-sub">Choose what Gemini sees from your desk.</div>
            </div>
          </div>
          <div class="side-list">
            ${sliceToggle('accounts', 'Prop accounts & DD', `${snap?.accounts.length ?? 0} active accounts`)}
            ${sliceToggle('trades', 'Trades & Setup Watch', `${snap?.tradeCount ?? 0} trades, ${snap?.openWatchCount ?? 0} watches`)}
            ${sliceToggle('cashflow', 'Payouts, budget & goals', `${snap?.goalsCount ?? 0} goals tracked`)}
            ${sliceToggle('psychology', 'Fear cards & charter', `${snap?.fearCardCount ?? 0} fear logs, ${snap?.openBreaches ?? 0} breaches`)}
          </div>
        </section>

        <section class="card">
          <div class="card-head tight">
            <div>
              <div class="card-title">One-click desk audits</div>
              <div class="card-sub">Run deep checks across your ledger.</div>
            </div>
          </div>
          <div class="stack" style="gap:8px;margin-top:8px">
            <button type="button" class="btn btn-ghost btn-sm" style="justify-content:flex-start" data-ai-act="preset-audit" data-kind="prop">Audit prop buffers &amp; sizing</button>
            <button type="button" class="btn btn-ghost btn-sm" style="justify-content:flex-start" data-ai-act="preset-audit" data-kind="leaks">Find R-expectancy &amp; grade leaks</button>
            <button type="button" class="btn btn-ghost btn-sm" style="justify-content:flex-start" data-ai-act="preset-audit" data-kind="macro">Live FX macro &amp; calendar risk</button>
            <button type="button" class="btn btn-ghost btn-sm" style="justify-content:flex-start" data-ai-act="preset-audit" data-kind="payout">Plan next payout split &amp; runway</button>
          </div>
        </section>
      </div>
    `;
  }

  renderPage(): string {
    this.mountStyles();
    const snap = this.getSnapshot();
    const topAcc = snap?.accounts[0];
    const bufferLabel = topAcc ? topAcc.bufferFormatted : (snap?.totalEquityFormatted || '$0.00');
    const bufferPct = topAcc ? `${topAcc.bufferPct.toFixed(0)}% room left` : 'Ready';
    const dailyLabel = topAcc ? topAcc.dailyRemainingFormatted : '$0.00';
    const searchStatus = this.prefs.useSearch ? `Search On (${this.getSearchBadgeSuffix()})` : 'Live FX Spot & Wires';

    return `
      <div class="page">
        <div class="page-head">
          <div>
            <div class="page-eyebrow"><span class="dot"></span> Intelligence Command Desk</div>
            <h1 class="page-title">AI Desk &amp; Copilot</h1>
            <p class="page-sub">Dedicated trading intelligence grounded in your live prop drawdown buffers, trade execution history, and macro FX catalysts.</p>
          </div>
          <div class="page-actions">
            <div class="lane-switch" role="tablist" aria-label="AI Desk mode">
              <button type="button" class="lane-btn ${this.activeTab === 'chat' ? 'active' : ''}" data-ai-act="tab" data-tab="chat">Chat &amp; Search</button>
              <button type="button" class="lane-btn ${this.activeTab === 'voice' ? 'active' : ''}" data-ai-act="tab" data-tab="voice">Live Voice</button>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-ai-act="reset-chat">New thread</button>
          </div>
        </div>

        <div class="ai-landing-hero">
          <div class="ai-landing-stats">
            <div class="ai-hero-stat">
              <span class="ai-hero-k">Prop Drawdown Buffer</span>
              <span class="ai-hero-v mint">${escapeAttr(bufferLabel)}</span>
              <span class="ai-hero-sub">${escapeAttr(bufferPct)}</span>
            </div>
            <div class="ai-hero-stat">
              <span class="ai-hero-k">Daily Loss Room</span>
              <span class="ai-hero-v">${escapeAttr(dailyLabel)}</span>
              <span class="ai-hero-sub">${topAcc ? `Account: ${escapeAttr(topAcc.name)}` : 'Active accounts'}</span>
            </div>
            <div class="ai-hero-stat">
              <span class="ai-hero-k">Intelligence Engine</span>
              <span class="ai-hero-v sky">${escapeAttr(this.prefs.model)}</span>
              <span class="ai-hero-sub">Persona: ${escapeAttr(this.prefs.persona.toUpperCase())}</span>
            </div>
            <div class="ai-hero-stat">
              <span class="ai-hero-k">Market Grounding</span>
              <span class="ai-hero-v amber">${escapeAttr(searchStatus)}</span>
              <span class="ai-hero-sub">ECB, Fed &amp; Live Feeds</span>
            </div>
          </div>
          <div class="ai-landing-presets">
            <button type="button" class="ai-landing-preset-btn" data-ai-act="preset-audit" data-kind="prop">
              <span class="ai-preset-icon">🛡️</span>
              <div>
                <div class="ai-preset-title">Audit Prop Buffers</div>
                <div class="ai-preset-desc">Daily room, max DD &amp; sizing</div>
              </div>
            </button>
            <button type="button" class="ai-landing-preset-btn" data-ai-act="preset-audit" data-kind="leaks">
              <span class="ai-preset-icon">⚡</span>
              <div>
                <div class="ai-preset-title">Find R-Expectancy Leaks</div>
                <div class="ai-preset-desc">Grade adherence &amp; checklist discipline</div>
              </div>
            </button>
            <button type="button" class="ai-landing-preset-btn" data-ai-act="preset-audit" data-kind="macro">
              <span class="ai-preset-icon">🌐</span>
              <div>
                <div class="ai-preset-title">Live Macro &amp; News Brief</div>
                <div class="ai-preset-desc">Central banks &amp; session catalysts</div>
              </div>
            </button>
            <button type="button" class="ai-landing-preset-btn" data-ai-act="preset-audit" data-kind="payout">
              <span class="ai-preset-icon">💰</span>
              <div>
                <div class="ai-preset-title">Payout Waterfall &amp; Runway</div>
                <div class="ai-preset-desc">Split, tax reserve &amp; cashflow</div>
              </div>
            </button>
          </div>
        </div>

        <div class="ai-workspace">
          <section class="card ai-panel" id="ai-page-panel">
            ${this.activeTab === 'chat' ? this.renderChatBodyHtml('page') : this.renderVoiceBodyHtml()}
          </section>
          ${this.renderContextSidebarHtml()}
        </div>
      </div>
    `;
  }

  private renderDrawerDom() {
    this.mountStyles();
    let backdrop = document.getElementById('lw-ai-drawer-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'lw-ai-drawer-backdrop';
      backdrop.className = 'ai-drawer-backdrop';
      document.body.appendChild(backdrop);
    }
    backdrop.hidden = !this.drawerOpen;
    if (!this.drawerOpen) {
      backdrop.innerHTML = '';
      return;
    }

    backdrop.innerHTML = `
      <div class="ai-drawer" role="dialog" aria-modal="true" aria-label="Ledgerwise AI Copilot">
        <div class="ai-drawer-head">
          <div>
            <div class="card-title-sm">Ledgerwise AI Copilot</div>
            <div class="tiny muted">${escapeAttr(this.prefs.model)}${this.prefs.useSearch ? ' · Search on' : ''}</div>
          </div>
          <div class="row" style="gap:6px">
            <button type="button" class="btn btn-ghost btn-sm" data-ai-act="open-full-ai">Full desk</button>
            <button type="button" class="btn btn-ghost btn-sm" data-ai-act="reset-chat">Clear</button>
            <button type="button" class="btn-icon" data-ai-act="close-drawer" aria-label="Close AI Copilot">✕</button>
          </div>
        </div>
        <div class="ai-panel">
          ${this.renderChatBodyHtml('drawer')}
        </div>
      </div>
    `;
    this.scrollThreadsToBottom();
  }

  afterRender() {
    this.scrollThreadsToBottom();
    if (this.activeTab === 'voice') {
      this.drawVoiceVisualizer();
    }
  }

  private refreshUi() {
    const pagePanel = document.getElementById('ai-page-panel');
    if (pagePanel) {
      pagePanel.innerHTML =
        this.activeTab === 'chat' ? this.renderChatBodyHtml('page') : this.renderVoiceBodyHtml();
      // Keep lane switch active state in sync
      const tabBtns = document.querySelectorAll('[data-ai-act="tab"]');
      tabBtns.forEach((btn) => {
        const el = btn as HTMLElement;
        el.classList.toggle('active', el.dataset.tab === this.activeTab);
      });
    }
    if (this.drawerOpen) {
      this.renderDrawerDom();
    }
    this.scrollThreadsToBottom();
    if (this.activeTab === 'voice') {
      this.drawVoiceVisualizer();
    }
  }

  private refreshVoiceTranscriptDom() {
    const box = document.getElementById('ai-voice-transcripts');
    if (!box) return;
    box.innerHTML = this.transcripts
      .map(
        (t) => `
        <div class="ai-vt-row">
          <span class="ai-vt-speaker ${t.speaker}">${t.speaker === 'you' ? 'You' : t.speaker === 'ai' ? 'Gemini' : 'Desk'}</span>
          <span style="color:var(--text-2);flex:1">${escapeAttr(t.text)}</span>
          <span class="mono tiny muted">${escapeAttr(t.at)}</span>
        </div>`
      )
      .join('');
    box.scrollTop = box.scrollHeight;
  }

  private scrollThreadsToBottom() {
    document.querySelectorAll('[data-ai-thread]').forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }

  private drawVoiceVisualizer() {
    const canvas = document.getElementById('ai-voice-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(document.documentElement);
    const mint = styles.getPropertyValue('--mint').trim() || '#5fe3b3';
    const amber = styles.getPropertyValue('--amber').trim() || '#f4b75a';
    const track = styles.getPropertyValue('--track').trim() || '#2a2a2c';

    const barCount = 36;
    const gap = 6;
    const barW = (w - gap * (barCount - 1)) / barCount;
    const midY = h / 2;
    const activeEnergy = Math.max(this.inLevel, this.outLevel);
    const isAiSpeaking = this.outLevel > this.inLevel && this.outLevel > 0.04;
    const t = Date.now() / 160;

    for (let i = 0; i < barCount; i++) {
      const distCenter = Math.abs(i - (barCount - 1) / 2) / (barCount / 2);
      const envelope = Math.max(0.15, 1 - distCenter * 0.72);
      const wave =
        this.voiceStatus === 'connected'
          ? (Math.sin(t + i * 0.45) * 0.5 + 0.5) * Math.max(0.1, activeEnergy)
          : 0.06;
      const barH = Math.max(4, Math.min(h - 10, (0.08 + wave * 0.92) * envelope * (h - 12)));
      ctx.fillStyle =
        this.voiceStatus !== 'connected'
          ? track
          : isAiSpeaking
            ? amber
            : mint;
      const x = i * (barW + gap);
      const y = midY - barH / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 3);
      ctx.fill();
    }
  }

  async openDrawer(opts?: { prompt?: string; persona?: AiPersona; tradeId?: string; useSearch?: boolean }) {
    if (opts?.persona) {
      this.prefs.persona = opts.persona;
      this.savePrefs();
    }
    if (typeof opts?.useSearch === 'boolean') {
      this.prefs.useSearch = opts.useSearch;
      this.savePrefs();
    }
    if (opts?.tradeId && window.__LW_BRIDGE__) {
      const ctx = window.__LW_BRIDGE__.getTradePromptContext(opts.tradeId);
      if (ctx) {
        this.draft = ctx.prompt;
        for (const sid of ctx.shotIds.slice(0, 2)) {
          try {
            const dataUrl = await window.__LW_BRIDGE__.loadShotDataUrl(sid);
            if (dataUrl && !this.attachments.some((a) => a.dataUrl === dataUrl)) {
              this.attachments.push({ name: `trade_${sid}.jpg`, dataUrl });
            }
          } catch {
            // ignore missing shot
          }
        }
      }
    } else if (opts?.prompt) {
      this.draft = opts.prompt;
    }

    this.drawerOpen = true;
    this.renderDrawerDom();
  }

  closeDrawer() {
    this.drawerOpen = false;
    this.renderDrawerDom();
  }

  setTab(tab: 'chat' | 'voice') {
    this.activeTab = tab;
    this.refreshUi();
  }

  private async sendChat(overrideText?: string) {
    const text = (overrideText ?? this.draft).trim();
    if ((!text && this.attachments.length === 0) || this.isSending) return;

    this.errorText = null;
    const userMsg: AiChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      text: text || 'Review the attached chart picture(s).',
      timestamp: nowTimeLabel(),
      attachments: this.attachments.length > 0 ? [...this.attachments] : undefined,
    };

    this.messages.push(userMsg);
    if (!overrideText) this.draft = '';
    this.attachments = [];
    this.showLedgerShotPicker = false;
    this.isSending = true;
    this.saveMessages();
    this.refreshUi();

    try {
      const apiMessages = this.messages
        .filter((m) => m.id !== 'ai_welcome')
        .slice(-16)
        .map((m) => ({
          role: m.role,
          text: m.text,
          attachments: m.attachments,
        }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          model: this.prefs.model,
          thinkingMode: this.prefs.thinkingMode,
          persona: this.prefs.persona,
          useSearch: this.prefs.useSearch,
          ledgerContext: this.getContextString(),
        }),
      });

      const data = (await res.json()) as {
        reply?: string;
        modelUsed?: string;
        searchUsed?: boolean;
        searchProvider?: string;
        sources?: GroundingSource[];
        searchQueries?: string[];
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error || `Gemini request failed (${res.status})`);
      }

      const aiMsg: AiChatMessage = {
        id: `m_${Date.now()}`,
        role: 'model',
        text: data.reply || 'No response text generated.',
        timestamp: nowTimeLabel(),
        modelUsed: data.modelUsed || this.prefs.model,
        searchUsed: Boolean(data.searchUsed),
        searchProvider: data.searchProvider,
        sources: Array.isArray(data.sources) ? data.sources : undefined,
        searchQueries: Array.isArray(data.searchQueries) ? data.searchQueries : undefined,
      };

      this.messages.push(aiMsg);
      this.saveMessages();
    } catch (err) {
      this.errorText =
        err instanceof Error ? err.message : 'Unable to reach Gemini service.';
    } finally {
      this.isSending = false;
      this.refreshUi();
    }
  }

  private async handleImageFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const processed = await Promise.all(
      images.slice(0, 3).map((f) => processImageFile(f, 1280))
    );
    for (const p of processed) {
      if (this.attachments.length < 4) {
        this.attachments.push({ name: p.fileName, dataUrl: p.dataUrl });
      }
    }
    this.refreshUi();
  }

  bindGlobalEvents() {
    document.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const backdrop = document.getElementById('lw-ai-drawer-backdrop');
      if (backdrop && target === backdrop) {
        this.closeDrawer();
        return;
      }

      const actEl = target.closest('[data-ai-act]') as HTMLElement | null;
      if (!actEl) return;

      const act = actEl.dataset.aiAct;
      switch (act) {
        case 'tab': {
          const tab = actEl.dataset.tab === 'voice' ? 'voice' : 'chat';
          this.setTab(tab);
          break;
        }
        case 'set-persona': {
          const p = actEl.dataset.persona as AiPersona;
          if (p) {
            this.prefs.persona = p;
            this.savePrefs();
            this.refreshUi();
          }
          break;
        }
        case 'toggle-search': {
          this.prefs.useSearch = !this.prefs.useSearch;
          this.savePrefs();
          this.refreshUi();
          break;
        }
        case 'reset-chat': {
          this.messages = [defaultWelcomeMessage()];
          this.errorText = null;
          this.saveMessages();
          this.refreshUi();
          break;
        }
        case 'send': {
          await this.sendChat();
          break;
        }
        case 'quick-prompt': {
          const qidx = Number(actEl.dataset.qidx);
          const qp = buildQuickPrompts(this.getSnapshot())[qidx];
          if (qp) {
            if (qp.persona) this.prefs.persona = qp.persona;
            if (typeof qp.useSearch === 'boolean') this.prefs.useSearch = qp.useSearch;
            this.savePrefs();
            await this.sendChat(qp.prompt);
          }
          break;
        }
        case 'preset-audit': {
          const kind = actEl.dataset.kind;
          if (kind === 'prop') {
            this.prefs.persona = 'risk';
            this.prefs.useSearch = false;
            this.savePrefs();
            this.setTab('chat');
            await this.sendChat('Audit every active prop account: daily loss room, max drawdown buffer, risk ladder step, and whether any rule or breach requires sizing down right now.');
          } else if (kind === 'leaks') {
            this.prefs.persona = 'coach';
            this.prefs.useSearch = false;
            this.savePrefs();
            this.setTab('chat');
            await this.sendChat('Review my trade grades, checklist scores, sessions, and fear logs. Identify my top 2 behavioral or execution leaks and give concrete corrective rules.');
          } else if (kind === 'macro') {
            this.prefs.persona = 'macro';
            this.prefs.useSearch = true;
            this.savePrefs();
            this.setTab('chat');
            await this.sendChat('Search live FX macro news, central bank rate expectations, and upcoming high-impact economic releases for USD, EUR, GBP, JPY, and XAUUSD today.');
          } else if (kind === 'payout') {
            this.prefs.persona = 'cfo';
            this.prefs.useSearch = false;
            this.savePrefs();
            this.setTab('chat');
            await this.sendChat('Inspect my payout pipeline, monthly income vs expenses, tax reserve, and household runway. Recommend how to allocate my next payout across tax, runway buffer, and goals.');
          }
          break;
        }
        case 'pick-file': {
          const scope = actEl.dataset.scope || 'page';
          const input = document.querySelector(`[data-ai-file="${scope}"]`) as HTMLInputElement | null;
          input?.click();
          break;
        }
        case 'toggle-shot-picker': {
          this.showLedgerShotPicker = !this.showLedgerShotPicker;
          this.refreshUi();
          break;
        }
        case 'attach-ledger-shot': {
          const shotId = actEl.dataset.shotId;
          const label = actEl.dataset.shotLabel || 'ledger_chart.jpg';
          if (shotId && window.__LW_BRIDGE__) {
            try {
              const dataUrl = await window.__LW_BRIDGE__.loadShotDataUrl(shotId);
              if (dataUrl) {
                this.attachments.push({ name: label, dataUrl });
                this.showLedgerShotPicker = false;
                this.refreshUi();
              } else {
                window.__LW_BRIDGE__.toast('Could not load that picture from local cache.', 'error');
              }
            } catch {
              window.__LW_BRIDGE__.toast('Could not read chart picture.', 'error');
            }
          }
          break;
        }
        case 'remove-att': {
          const idx = Number(actEl.dataset.idx);
          if (Number.isFinite(idx)) {
            this.attachments.splice(idx, 1);
            this.refreshUi();
          }
          break;
        }
        case 'copy': {
          const msgId = actEl.dataset.msgId;
          const found = this.messages.find((m) => m.id === msgId);
          if (found && navigator.clipboard) {
            await navigator.clipboard.writeText(found.text);
            window.__LW_BRIDGE__?.toast('Copied AI note to clipboard.', 'success');
          }
          break;
        }
        case 'close-drawer': {
          this.closeDrawer();
          break;
        }
        case 'open-full-ai': {
          this.closeDrawer();
          window.__LW_BRIDGE__?.navigate('ai');
          break;
        }
        case 'voice-start': {
          try {
            await this.voiceClient.start({
              voiceName: this.prefs.voiceName,
              persona: this.prefs.persona,
              ledgerContext: this.getContextString(),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unable to start voice session.';
            window.__LW_BRIDGE__?.toast(msg, 'error');
          }
          break;
        }
        case 'voice-stop': {
          this.voiceClient.stop();
          break;
        }
        case 'voice-mute': {
          this.voiceMuted = !this.voiceMuted;
          this.voiceClient.setMuted(this.voiceMuted);
          this.refreshUi();
          break;
        }
        case 'voice-nudge': {
          const topic = actEl.dataset.topic;
          if (topic) {
            this.voiceClient.sendTextContext(topic);
            this.appendTranscript('system', `Topic sent: ${topic}`);
          }
          break;
        }
        case 'voice-clear': {
          this.transcripts = [];
          this.refreshVoiceTranscriptDom();
          break;
        }
      }
    });

    document.addEventListener('change', async (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target instanceof HTMLInputElement && target.dataset.aiFile) {
        await this.handleImageFiles(target.files);
        target.value = '';
        return;
      }

      if (target instanceof HTMLInputElement && target.dataset.aiSlice) {
        const key = target.dataset.aiSlice as keyof ContextSlices;
        this.prefs.slices[key] = target.checked;
        this.savePrefs();
        return;
      }

      if (target instanceof HTMLSelectElement && target.dataset.aiChange) {
        const kind = target.dataset.aiChange;
        if (kind === 'model') {
          this.prefs.model = target.value === 'gemini-3.1-flash-lite' ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';
          this.savePrefs();
          this.refreshUi();
        } else if (kind === 'thinking') {
          const val = target.value;
          this.prefs.thinkingMode = val === 'deep' || val === 'low' ? val : 'high';
          this.savePrefs();
        } else if (kind === 'voice') {
          const val = target.value as LiveVoiceName;
          if (VOICES.includes(val)) {
            this.prefs.voiceName = val;
            this.savePrefs();
          }
        }
      }
    });

    document.addEventListener('input', (e) => {
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLTextAreaElement && target.dataset.aiInput) {
        this.draft = target.value;
      }
    });

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLTextAreaElement && target.dataset.aiInput) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendChat();
        }
      } else if (e.key === 'Escape' && this.drawerOpen) {
        this.closeDrawer();
      }
    });

    document.addEventListener('paste', async (e) => {
      const active = document.activeElement as HTMLElement | null;
      if (!(active instanceof HTMLTextAreaElement) || !active.dataset.aiInput) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imgItem = items.find((it) => it.type.startsWith('image/'));
      if (!imgItem) return;
      const file = imgItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      const processed = await processImageFile(file, 1280);
      if (this.attachments.length < 4) {
        this.attachments.push({ name: processed.fileName, dataUrl: processed.dataUrl });
        this.refreshUi();
      }
    });
  }
}

const aiController = new LedgerwiseAiController();
aiController.bindGlobalEvents();

window.__LW_AI__ = {
  renderPage: () => aiController.renderPage(),
  afterRender: () => aiController.afterRender(),
  openDrawer: (opts) => aiController.openDrawer(opts),
  closeDrawer: () => aiController.closeDrawer(),
  setTab: (tab) => aiController.setTab(tab),
  syncFromCloud: () => aiController.syncFromCloud(true),
};

if (location.hash === '#ai' && document.getElementById('view')?.textContent?.includes('Loading Gemini AI workspace')) {
  window.__LW_BRIDGE__?.navigate('ai');
}
