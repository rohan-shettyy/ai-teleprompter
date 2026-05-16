function splitWords(transcript) {
  return transcript.trim().split(/\s+/).filter(Boolean);
}

class BaseSpeechProvider {
  constructor({ onStatus, onError, onToast }) {
    this.callbacks = new Set();
    this.onStatus = onStatus;
    this.onError = onError;
    this.onToast = onToast;
  }

  onWord(callback) {
    this.callbacks.add(callback);

    return () => {
      this.callbacks.delete(callback);
    };
  }

  emitWord(event) {
    this.callbacks.forEach((callback) => callback(event));
  }

  emitTranscript(transcript, isFinal) {
    splitWords(transcript).forEach((word) => {
      this.emitWord({
        word,
        transcript,
        isFinal,
      });
    });
  }

  setStatus(status, label) {
    this.onStatus?.(status, label);
  }

  fail(message) {
    this.onError?.(message);
  }

  toast(message) {
    this.onToast?.(message);
  }
}

export class WebSpeechProvider extends BaseSpeechProvider {
  recognition = null;
  restartTimer = 0;
  shouldListen = false;
  hasError = false;

  start() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    this.hasError = false;
    this.shouldListen = true;

    if (!Recognition) {
      this.shouldListen = false;
      this.hasError = true;
      this.toast("Mic denied");
      this.fail(
        "Speech recognition is not supported in this browser. Try Chrome or Edge with microphone access enabled.",
      );
      return false;
    }

    const recognition = new Recognition();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      if (this.shouldListen) {
        this.setStatus("listening", "Mic listening");
      }
    };

    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        this.emitTranscript(result[0].transcript, result.isFinal);
      }
    };

    recognition.onerror = (event) => {
      if (!this.shouldListen) {
        return;
      }

      const recoverableErrors = new Set(["aborted", "network", "no-speech"]);

      if (recoverableErrors.has(event.error)) {
        this.setStatus("paused", "Mic reconnecting");
        return;
      }

      this.shouldListen = false;
      this.hasError = true;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.toast("Mic denied");
      }
      this.fail(`Microphone error: ${event.error}. Check browser permissions and try Start again.`);
    };

    recognition.onend = () => {
      if (this.shouldListen) {
        this.scheduleRestart();
        return;
      }

      if (!this.hasError) {
        this.setStatus("paused", "Mic paused");
      }
    };

    try {
      recognition.start();
      this.setStatus("paused", "Mic starting");
      return true;
    } catch {
      this.hasError = true;
      this.toast("Mic denied");
      this.fail("Could not start microphone recognition. Check browser permissions and try again.");
      return false;
    }
  }

  scheduleRestart() {
    window.clearTimeout(this.restartTimer);

    if (!this.shouldListen || !this.recognition) {
      return;
    }

    this.setStatus("paused", "Mic reconnecting");
    this.restartTimer = window.setTimeout(() => {
      if (!this.shouldListen || !this.recognition) {
        return;
      }

      try {
        this.recognition.start();
      } catch {
        this.scheduleRestart();
      }
    }, 250);
  }

  stop() {
    this.shouldListen = false;
    window.clearTimeout(this.restartTimer);
    this.setStatus("paused", "Mic paused");

    if (!this.recognition) {
      return;
    }

    this.recognition.onend = null;

    try {
      this.recognition.stop();
    } catch {
      this.recognition.abort();
    }

    this.recognition = null;
  }
}

export class DeepgramProvider extends BaseSpeechProvider {
  constructor(options) {
    super(options);
    this.apiKey = options.apiKey;
    this.socket = null;
    this.stream = null;
    this.recorder = null;
    this.closedByUser = false;
    this.fallbackRequested = false;
    this.retryCount = 0;
    this.reconnectTimer = 0;
    this.reconnecting = false;
  }

  async start() {
    if (!this.apiKey || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return false;
    }

    try {
      this.closedByUser = false;
      this.fallbackRequested = false;
      this.retryCount = 0;
      this.setStatus("paused", "Mic starting");
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this.toast("Mic denied");
      this.stop();
      return false;
    }

    try {
      await this.openSocket();
      this.startRecorder();
      this.setStatus("listening", "Deepgram listening");
      return true;
    } catch (error) {
      this.stop();
      return false;
    }
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const url = "wss://api.deepgram.com/v1/listen?interim_results=true&model=nova-2";
      const socket = new WebSocket(url, ["token", this.apiKey]);
      this.socket = socket;
      let opened = false;

      const failToOpen = window.setTimeout(() => {
        reject(new Error("Deepgram connection timed out."));
      }, 3000);

      socket.onopen = () => {
        window.clearTimeout(failToOpen);
        opened = true;
        resolve();
      };

      socket.onerror = () => {
        window.clearTimeout(failToOpen);

        if (opened) {
          this.scheduleReconnect();
          return;
        }

        reject(new Error("Deepgram connection failed."));
      };

      socket.onmessage = (message) => {
        this.handleMessage(message.data);
      };

      socket.onclose = () => {
        if (opened && !this.closedByUser) {
          this.scheduleReconnect();
          return;
        }

        this.setStatus("paused", "Mic paused");
      };
    });
  }

  startRecorder() {
    if (this.recorder && this.recorder.state !== "inactive") {
      return;
    }

    const preferredTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

    this.recorder.ondataavailable = (event) => {
      if (!event.data.size || this.socket?.readyState !== WebSocket.OPEN) {
        return;
      }

      this.socket.send(event.data);
    };

    this.recorder.start(100);
  }

  handleMessage(rawMessage) {
    let payload;

    try {
      payload = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (payload.type !== "Results") {
      return;
    }

    const transcript = payload.channel?.alternatives?.[0]?.transcript?.trim();

    if (!transcript) {
      return;
    }

    this.emitTranscript(transcript, Boolean(payload.is_final));
  }

  requestFallback() {
    if (this.fallbackRequested) {
      return;
    }

    this.fallbackRequested = true;
    this.stop();
    this.options.onFallback?.();
  }

  scheduleReconnect() {
    if (this.closedByUser || this.fallbackRequested || this.reconnecting) {
      return;
    }

    this.retryCount += 1;

    if (this.retryCount > 5) {
      this.toast("STT disconnected");
      this.requestFallback();
      return;
    }

    const delay = Math.min(8000, 250 * 2 ** (this.retryCount - 1));
    this.reconnecting = true;
    this.setStatus("paused", `Deepgram reconnecting ${this.retryCount}/5`);
    this.toast("Reconnecting STT");

    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnecting = false;

      if (this.closedByUser || this.fallbackRequested) {
        return;
      }

      try {
        await this.openSocket();
        this.retryCount = 0;
        this.startRecorder();
        this.setStatus("listening", "Deepgram listening");
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  stop() {
    this.closedByUser = true;
    window.clearTimeout(this.reconnectTimer);

    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }

    this.stream?.getTracks().forEach((track) => track.stop());

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "CloseStream" }));
      this.socket.close();
    } else {
      this.socket?.close();
    }

    this.recorder = null;
    this.stream = null;
    this.socket = null;
    this.setStatus("paused", "Mic paused");
  }
}

class PreferredSpeechProvider extends BaseSpeechProvider {
  activeProvider = null;
  unsubscribeActiveProvider = null;

  constructor(options) {
    super(options);
    this.options = options;
  }

  async start() {
    const deepgramProvider = new DeepgramProvider({
      ...this.options,
      onFallback: () => {
        this.fallbackToWebSpeech();
      },
    });
    this.bindActiveProvider(deepgramProvider);

    if (await deepgramProvider.start()) {
      return true;
    }

    this.unbindActiveProvider();

    const webSpeechProvider = new WebSpeechProvider(this.options);
    this.bindActiveProvider(webSpeechProvider);
    return webSpeechProvider.start();
  }

  fallbackToWebSpeech() {
    if (this.activeProvider instanceof WebSpeechProvider) {
      return;
    }

    this.unbindActiveProvider();
    this.toast("STT disconnected");
    const webSpeechProvider = new WebSpeechProvider(this.options);
    this.bindActiveProvider(webSpeechProvider);
    webSpeechProvider.start();
  }

  bindActiveProvider(provider) {
    this.activeProvider = provider;
    this.unsubscribeActiveProvider = provider.onWord((event) => {
      this.emitWord(event);
    });
  }

  unbindActiveProvider() {
    this.unsubscribeActiveProvider?.();
    this.activeProvider?.stop?.();
    this.unsubscribeActiveProvider = null;
    this.activeProvider = null;
  }

  stop() {
    this.unbindActiveProvider();
  }
}

export function createSpeechProvider(options) {
  return new PreferredSpeechProvider(options);
}
