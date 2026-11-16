export type AiPersona = 'coach' | 'risk' | 'cfo' | 'macro';
export type AiModel = 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
export type AiThinkingMode = 'low' | 'high' | 'deep';
export type LiveVoiceName = 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';

export interface AiAttachment {
  name: string;
  dataUrl: string;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface AiChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
  modelUsed?: string;
  searchUsed?: boolean;
  searchProvider?: string;
  sources?: GroundingSource[];
  searchQueries?: string[];
  attachments?: AiAttachment[];
}

export interface ContextSlices {
  accounts: boolean;
  trades: boolean;
  cashflow: boolean;
  psychology: boolean;
}

export interface VoiceTranscriptEntry {
  id: string;
  speaker: 'you' | 'ai' | 'system';
  text: string;
  at: string;
}

export interface LedgerAccountSnapshot {
  id: string;
  name: string;
  firm: string;
  kind: string;
  currency: string;
  equityFormatted: string;
  profitFormatted: string;
  dailyRemainingFormatted: string;
  bufferFormatted: string;
  bufferPct: number;
  dailyUsedPct: number;
  level: string;
  payoutEligible: boolean;
  healthScore: number;
  effectiveRiskPct: number;
}

export interface LedgerTradeSnapshot {
  id: string;
  date: string;
  pair: string;
  direction: string;
  session: string;
  setup: string;
  grade: string;
  r: number | null;
  netFormatted: string;
  pips: number | null;
  checkScore?: number;
  checkTotal?: number;
  shotCount: number;
}

export interface LedgerShotMeta {
  id: string;
  owner: string;
  slot: string;
  at: string;
  label: string;
}

export interface LedgerSnapshot {
  traderName: string;
  currency: string;
  homeCurrency: string;
  currentPage: string;
  healthScore: number;
  healthLabel: string;
  runwayMonths: number | null;
  totalEquityFormatted: string;
  expectedPayoutFormatted: string;
  monthIncomeFormatted: string;
  monthExpensesFormatted: string;
  monthTaxFormatted: string;
  monthSpendableFormatted: string;
  tradeCount: number;
  backtestCount: number;
  winRatePct: number | null;
  expectancyFormatted: string;
  profitFactorLabel: string;
  accounts: LedgerAccountSnapshot[];
  recentTrades: LedgerTradeSnapshot[];
  openWatchCount: number;
  openWatches: Array<{ pair: string; windowLabel: string; bias: string; trigger: string }>;
  fearCardCount: number;
  recentFear: Array<{ date: string; trigger: string; emotion: string; cost: string }>;
  openBreaches: number;
  charterAdopted: boolean;
  goalsCount: number;
  goalsSummary: Array<{ title: string; progressPct: number; targetFormatted: string }>;
  availableShots: LedgerShotMeta[];
}

export interface CloudSyncStatus {
  enabled: boolean;
  signedIn: boolean;
  email: string;
  status: string;
}

export interface CloudAiStatePayload {
  prefs: {
    persona: AiPersona;
    model: AiModel;
    thinkingMode: AiThinkingMode;
    useSearch: boolean;
    voiceName: LiveVoiceName;
    slices: ContextSlices;
  } | null;
  messages: AiChatMessage[];
}

export interface LedgerwiseBridge {
  getSnapshot: () => LedgerSnapshot;
  loadShotDataUrl: (shotId: string) => Promise<string>;
  getTradePromptContext: (tradeId: string) => { prompt: string; shotIds: string[] } | null;
  getCloudStatus?: () => CloudSyncStatus;
  getAiState?: () => CloudAiStatePayload;
  saveAiState?: (aiState: CloudAiStatePayload) => void;
  toast: (message: string, type?: 'success' | 'error' | 'info') => void;
  navigate: (page: string) => void;
  esc: (val: unknown) => string;
}

declare global {
  interface Window {
    __LW_BRIDGE__?: LedgerwiseBridge;
    __LW_AI__?: {
      renderPage: () => string;
      afterRender: () => void;
      openDrawer: (opts?: { prompt?: string; persona?: AiPersona; tradeId?: string; useSearch?: boolean }) => void;
      closeDrawer: () => void;
      setTab: (tab: 'chat' | 'voice') => void;
      syncFromCloud?: () => void;
    };
  }
}
