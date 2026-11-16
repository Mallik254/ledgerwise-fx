import type { AiPersona, LiveVoiceName } from './types';

export interface VoiceClientCallbacks {
  onStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onLevel?: (inputLevel: number, outputLevel: number) => void;
}

function float32To16kPcmBase64(input: Float32Array, sourceRate: number): string {
  const targetRate = 16000;
  let samples: Float32Array;

  if (sourceRate === targetRate) {
    samples = input;
  } else {
    const ratio = sourceRate / targetRate;
    const newLen = Math.max(1, Math.round(input.length / ratio));
    samples = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx] ?? 0;
      const s1 = input[Math.min(idx + 1, input.length - 1)] ?? s0;
      samples[i] = s0 + (s1 - s0) * frac;
    }
  }

  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64PcmToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = Math.floor(len / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export class GeminiLiveVoiceClient {
  private ws: WebSocket | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private muted = false;
  private inputLevel = 0;
  private rafId = 0;
  private callbacks: VoiceClientCallbacks;

  constructor(callbacks: VoiceClientCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(mute: boolean): void {
    this.muted = mute;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.enabled = !mute;
      }
    }
  }

  async start(opts: {
    voiceName: LiveVoiceName;
    persona: AiPersona;
    ledgerContext: string;
  }): Promise<void> {
    this.stop();
    this.callbacks.onStatus('connecting', 'Requesting microphone access…');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Microphone access was blocked or unavailable.';
      this.callbacks.onStatus('error', msg);
      throw new Error(msg);
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.inputCtx = new AudioCtx({ sampleRate: 16000 });
    this.outputCtx = new AudioCtx({ sampleRate: 24000 });
    this.nextStartTime = this.outputCtx.currentTime;

    this.outputAnalyser = this.outputCtx.createAnalyser();
    this.outputAnalyser.fftSize = 128;
    this.outputAnalyser.connect(this.outputCtx.destination);

    if (this.inputCtx.state === 'suspended') await this.inputCtx.resume();
    if (this.outputCtx.state === 'suspended') await this.outputCtx.resume();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/live`;

    this.callbacks.onStatus('connecting', 'Connecting to Gemini Live (gemini-3.8-live)…');

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let settled = false;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'start',
            voiceName: opts.voiceName,
            persona: opts.persona,
            ledgerContext: opts.ledgerContext,
          })
        );
      };

      ws.onmessage = (event) => {
        let msg: {
          type?: string;
          data?: string;
          text?: string;
          error?: string;
        };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (msg.type === 'ready') {
          if (!settled) {
            settled = true;
            this.startMicPipeline();
            this.startMeterLoop();
            this.callbacks.onStatus('connected', `Live · ${opts.voiceName}`);
            resolve();
          }
          return;
        }

        if (msg.type === 'audio' && msg.data) {
          this.scheduleOutputAudio(msg.data);
          return;
        }

        if (msg.type === 'inputTranscript' && msg.text) {
          this.callbacks.onInputTranscript(msg.text);
          return;
        }

        if (msg.type === 'outputTranscript' && msg.text) {
          this.callbacks.onOutputTranscript(msg.text);
          return;
        }

        if (msg.type === 'interrupted') {
          this.clearScheduledOutput();
          this.callbacks.onInterrupted();
          return;
        }

        if (msg.type === 'turnComplete') {
          this.callbacks.onTurnComplete();
          return;
        }

        if (msg.type === 'error') {
          const errText = msg.error || 'Gemini Live connection failed.';
          this.callbacks.onStatus('error', errText);
          if (!settled) {
            settled = true;
            reject(new Error(errText));
          }
          this.stop(true);
          return;
        }

        if (msg.type === 'closed') {
          this.stop();
        }
      };

      ws.onerror = () => {
        const errText = 'WebSocket connection to Live Voice server failed.';
        this.callbacks.onStatus('error', errText);
        if (!settled) {
          settled = true;
          reject(new Error(errText));
        }
        this.stop(true);
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Voice session closed before becoming ready.'));
        }
        this.stop(true);
      };
    });
  }

  sendTextContext(text: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && text.trim()) {
      this.ws.send(JSON.stringify({ type: 'text', text: text.trim() }));
    }
  }

  private startMicPipeline(): void {
    if (!this.inputCtx || !this.mediaStream || !this.ws) return;
    this.sourceNode = this.inputCtx.createMediaStreamSource(this.mediaStream);
    this.processor = this.inputCtx.createScriptProcessor(4096, 1, 1);

    const silentGain = this.inputCtx.createGain();
    silentGain.gain.value = 0;

    this.processor.onaudioprocess = (ev) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.muted) {
        this.inputLevel = 0;
        return;
      }
      const channelData = ev.inputBuffer.getChannelData(0);
      let sumSq = 0;
      for (let i = 0; i < channelData.length; i++) {
        sumSq += channelData[i] * channelData[i];
      }
      this.inputLevel = Math.min(1, Math.sqrt(sumSq / channelData.length) * 5);

      const base64 = float32To16kPcmBase64(channelData, this.inputCtx?.sampleRate ?? 16000);
      this.ws.send(JSON.stringify({ type: 'audio', audio: base64 }));
    };

    this.sourceNode.connect(this.processor);
    this.processor.connect(silentGain);
    silentGain.connect(this.inputCtx.destination);
  }

  private scheduleOutputAudio(base64Pcm: string): void {
    if (!this.outputCtx || !this.outputAnalyser) return;
    const floatSamples = base64PcmToFloat32(base64Pcm);
    if (floatSamples.length === 0) return;

    const buffer = this.outputCtx.createBuffer(1, floatSamples.length, 24000);
    buffer.copyToChannel(new Float32Array(floatSamples), 0);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputAnalyser);

    const now = this.outputCtx.currentTime;
    const startAt = Math.max(now + 0.02, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
    source.start(startAt);
  }

  private clearScheduledOutput(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    if (this.outputCtx) {
      this.nextStartTime = this.outputCtx.currentTime;
    }
  }

  private startMeterLoop(): void {
    const bins = new Uint8Array(64);
    const tick = () => {
      let outLevel = 0;
      if (this.outputAnalyser && this.activeSources.size > 0) {
        this.outputAnalyser.getByteTimeDomainData(bins);
        let peak = 0;
        for (let i = 0; i < bins.length; i++) {
          const v = Math.abs(bins[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        outLevel = Math.min(1, peak * 2.4);
      }
      this.callbacks.onLevel?.(this.muted ? 0 : this.inputLevel, outLevel);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(silentDisconnect = false): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    this.clearScheduledOutput();

    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.inputCtx) {
      this.inputCtx.close().catch(() => {});
      this.inputCtx = null;
    }
    if (this.outputCtx) {
      this.outputCtx.close().catch(() => {});
      this.outputCtx = null;
    }
    this.outputAnalyser = null;

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'stop' }));
        } catch {
          // ignore
        }
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    }

    this.muted = false;
    this.inputLevel = 0;
    this.callbacks.onLevel?.(0, 0);
    if (!silentDisconnect) {
      this.callbacks.onStatus('disconnected', 'Voice session ended');
    } else {
      this.callbacks.onStatus('disconnected');
    }
  }
}
