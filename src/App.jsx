import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createSpeechProvider } from "./speechProviders.js";

const SPOKEN_BUFFER_SIZE = 8;
const SEARCH_WINDOW_SIZE = 12;
const MATCH_THRESHOLD = 0.55;
const INTERIM_MATCH_THRESHOLD = 0.72;
const OFF_SCRIPT_DELAY_MS = 4000;
const PACE_SAMPLE_SIZE = 10;
const PRE_SCROLL_LEAD_MS = 400;
const STARTUP_PREDICTIVE_WPM = 185;
const MIN_PREDICTIVE_WPM = 60;
const MAX_PREDICTIVE_WPM = 520;
const PAUSE_RESET_MS = 1800;
const MIN_PACE_INTERVAL_MS = 90;
const MAX_PACE_INTERVAL_MS = 1400;
const READING_LINE_INDEX = 1;
const SCROLL_TRIGGER_LINE_INDEX = 2;
const FAST_LINE_END_WORDS = 2;
const DEFAULT_FONT_SIZE = 56;
const MIN_FONT_SIZE = 32;
const MAX_FONT_SIZE = 80;

function normalizeToken(token) {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function getLastWords(text, count) {
  return text.trim().split(/\s+/).filter(Boolean).slice(-count);
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function similarityScore(left, right) {
  const leftText = left.join(" ");
  const rightText = right.join(" ");
  const longest = Math.max(leftText.length, rightText.length);

  if (longest === 0) {
    return 1;
  }

  return 1 - levenshteinDistance(leftText, rightText) / longest;
}

function findBestFuzzyMatch(spokenBuffer, scriptTokens, cursor) {
  if (!spokenBuffer.length) {
    return null;
  }

  const minEnd = cursor + 1;
  const maxEnd = Math.min(scriptTokens.length - 1, cursor + SEARCH_WINDOW_SIZE);
  let bestMatch = null;

  for (let end = minEnd; end <= maxEnd; end += 1) {
    const maxLength = Math.min(SPOKEN_BUFFER_SIZE, spokenBuffer.length, end + 1);
    const minLength = Math.max(1, Math.min(maxLength, spokenBuffer.length - 2));

    for (let length = minLength; length <= maxLength; length += 1) {
      const start = end - length + 1;
      const candidate = scriptTokens.slice(start, end + 1).map((token) => token.normalized);
      const spoken = spokenBuffer.slice(-length);
      const score = similarityScore(spoken, candidate);

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { start, end, score };
      }
    }
  }

  return bestMatch;
}

function tokenizeScript(script) {
  const parts = script.match(/\s+|\S+/g) || [];
  let tokenIndex = 0;

  return parts.map((text, partIndex) => {
    if (/^\s+$/.test(text)) {
      return { id: `space-${partIndex}`, text, type: "space" };
    }

    const normalized = normalizeToken(text);

    if (!normalized) {
      return { id: `plain-${partIndex}`, text, type: "plain" };
    }

    const token = {
      id: `token-${tokenIndex}-${partIndex}`,
      text,
      type: "token",
      normalized,
      tokenIndex,
    };

    tokenIndex += 1;
    return token;
  });
}

function App() {
  const [script, setScript] = useState("");
  const [isReading, setIsReading] = useState(false);
  const [micStatus, setMicStatus] = useState("paused");
  const [micLabel, setMicLabel] = useState("Mic paused");
  const [speechError, setSpeechError] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [cursor, setCursor] = useState(0);
  const [isOffScript, setIsOffScript] = useState(false);
  const [wpm, setWpm] = useState(null);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [isPaused, setIsPaused] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [toasts, setToasts] = useState([]);

  const promptRef = useRef(null);
  const tokenRefs = useRef([]);
  const cursorRef = useRef(-1);
  const visualCursorRef = useRef(-1);
  const spokenBufferRef = useRef([]);
  const interimSpokenBufferRef = useRef([]);
  const matchPaceRef = useRef([]);
  const predictiveScrollTimerRef = useRef(0);
  const noMatchSinceRef = useRef(null);
  const providerRef = useRef(null);
  const unsubscribeWordRef = useRef(null);
  const speechRunIdRef = useRef(0);
  const offScriptToastShownRef = useRef(false);

  const promptParts = useMemo(() => tokenizeScript(script.trim()), [script]);
  const scriptTokens = useMemo(
    () => promptParts.filter((part) => part.type === "token"),
    [promptParts],
  );
  const liveWords = getLastWords(`${finalTranscript} ${interimTranscript}`, 3);

  function setMicState(status, label) {
    setMicStatus(status);
    setMicLabel(label);
  }

  function showToast(message) {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current, { id, message }].slice(-3));
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
  }

  function showSpeechError(message) {
    setSpeechError(message);
    setMicState("error", "Mic error");

    if (/denied|not-allowed|permission/i.test(message)) {
      showToast("Mic denied");
    }
  }

  function clearSpeechError() {
    setSpeechError("");
  }

  function getPromptLineMetrics(index) {
    const prompt = promptRef.current;
    const tokenElement = tokenRefs.current[index];

    if (!prompt || !tokenElement) {
      return null;
    }

    const styles = window.getComputedStyle(prompt);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const visibleTop = tokenElement.offsetTop - prompt.scrollTop;
    const visibleLine = Math.floor((visibleTop + lineHeight * 0.2) / lineHeight);

    return {
      lineHeight,
      prompt,
      tokenElement,
      visibleLine,
    };
  }

  function scrollTokenIntoReadingLine(index, { onlyIfTooLow = false } = {}) {
    const metrics = getPromptLineMetrics(index);

    if (!metrics) {
      return;
    }

    if (onlyIfTooLow && metrics.visibleLine < SCROLL_TRIGGER_LINE_INDEX) {
      return;
    }

    const targetTop = metrics.tokenElement.offsetTop - metrics.lineHeight * READING_LINE_INDEX;
    const nextScrollTop = Math.max(0, targetTop);

    if (nextScrollTop <= metrics.prompt.scrollTop + 1) {
      return;
    }

    metrics.prompt.scrollTo({
      top: nextScrollTop,
      behavior: "smooth",
    });
  }

  function maybeSafetyScrollNearLineEnd(index, currentWpm) {
    const metrics = getPromptLineMetrics(index);

    if (!metrics) {
      return false;
    }

    const wordsUntilLineEnd = getWordsUntilLineEnd(index);
    const shouldScroll =
      metrics.visibleLine >= SCROLL_TRIGGER_LINE_INDEX ||
      (metrics.visibleLine >= READING_LINE_INDEX &&
        wordsUntilLineEnd <= FAST_LINE_END_WORDS &&
        currentWpm >= STARTUP_PREDICTIVE_WPM);

    if (!shouldScroll) {
      return false;
    }

    scrollTokenIntoReadingLine(index);
    return true;
  }

  function cancelPredictiveScroll() {
    window.clearTimeout(predictiveScrollTimerRef.current);
    predictiveScrollTimerRef.current = 0;
  }

  function updateSpeakingPace(index, timestamp) {
    const previous = matchPaceRef.current[matchPaceRef.current.length - 1];

    if (previous && timestamp - previous.timestamp > PAUSE_RESET_MS) {
      matchPaceRef.current = [];
    }

    matchPaceRef.current = [...matchPaceRef.current, { index, timestamp }].slice(-PACE_SAMPLE_SIZE);

    const intervals = [];

    for (let position = 1; position < matchPaceRef.current.length; position += 1) {
      const left = matchPaceRef.current[position - 1];
      const right = matchPaceRef.current[position];
      const wordsAdvanced = right.index - left.index;
      const elapsed = right.timestamp - left.timestamp;

      if (wordsAdvanced <= 0 || elapsed <= 0) {
        continue;
      }

      const msPerWord = elapsed / wordsAdvanced;

      if (msPerWord < MIN_PACE_INTERVAL_MS || msPerWord > MAX_PACE_INTERVAL_MS) {
        continue;
      }

      intervals.push(msPerWord);
    }

    if (!intervals.length) {
      setWpm(null);
      return null;
    }

    let weightedTotal = 0;
    let weightTotal = 0;

    intervals.forEach((interval, intervalIndex) => {
      const weight = intervalIndex + 1;
      weightedTotal += interval * weight;
      weightTotal += weight;
    });

    const averageMsPerWord = weightedTotal / weightTotal;
    const nextWpm = 60000 / averageMsPerWord;

    if (nextWpm < MIN_PREDICTIVE_WPM || nextWpm > MAX_PREDICTIVE_WPM) {
      setWpm(Math.round(nextWpm));
      return null;
    }

    setWpm(Math.round(nextWpm));
    return nextWpm;
  }

  function getWordsUntilLineEnd(index) {
    const currentElement = tokenRefs.current[index];

    if (!currentElement) {
      return 1;
    }

    const currentTop = currentElement.offsetTop;
    let words = 0;

    for (let nextIndex = index + 1; nextIndex < scriptTokens.length; nextIndex += 1) {
      const nextElement = tokenRefs.current[nextIndex];

      if (!nextElement || nextElement.offsetTop !== currentTop) {
        break;
      }

      words += 1;
    }

    return words;
  }

  function getPredictiveLeadMs(currentWpm) {
    if (currentWpm >= 300) {
      return 1150;
    }

    if (currentWpm >= 250) {
      return 980;
    }

    if (currentWpm >= 210) {
      return 820;
    }

    if (currentWpm >= 170) {
      return 650;
    }

    return PRE_SCROLL_LEAD_MS;
  }

  function schedulePredictiveScroll(matchedIndex, currentWpm, matchedAt) {
    cancelPredictiveScroll();

    if (isPaused || isMobile || !currentWpm || matchedIndex + 1 >= scriptTokens.length) {
      return;
    }

    const msPerWord = 60000 / currentWpm;
    const wordsUntilLineEnd = getWordsUntilLineEnd(matchedIndex);
    const lookaheadWords = Math.max(1, wordsUntilLineEnd + 1);
    const nextIndex = Math.min(scriptTokens.length - 1, matchedIndex + lookaheadWords);
    const expectedArrivalAt = matchedAt + msPerWord * lookaheadWords;
    const delay = Math.max(0, expectedArrivalAt - getPredictiveLeadMs(currentWpm) - Date.now());

    predictiveScrollTimerRef.current = window.setTimeout(() => {
      scrollTokenIntoReadingLine(nextIndex);
      predictiveScrollTimerRef.current = 0;
    }, delay);
  }

  function moveVisualCursor(index, currentWpm) {
    if (index <= visualCursorRef.current) {
      return;
    }

    visualCursorRef.current = index;
    setCursor(index);
    maybeSafetyScrollNearLineEnd(index, currentWpm);
  }

  function handleInterimTranscript(transcript) {
    const interimWords = transcript.trim().split(/\s+/).map(normalizeToken).filter(Boolean);

    if (!interimWords.length) {
      return;
    }

    interimSpokenBufferRef.current = [...spokenBufferRef.current, ...interimWords].slice(
      -SPOKEN_BUFFER_SIZE,
    );

    const bestMatch = findBestFuzzyMatch(
      interimSpokenBufferRef.current,
      scriptTokens,
      cursorRef.current,
    );

    if (!bestMatch || bestMatch.score < INTERIM_MATCH_THRESHOLD) {
      return;
    }

    moveVisualCursor(bestMatch.end, wpm || STARTUP_PREDICTIVE_WPM);
  }

  function handleFinalWord(word) {
    cancelPredictiveScroll();

    const finalWord = normalizeToken(word);

    if (!finalWord) {
      return;
    }

    spokenBufferRef.current = [...spokenBufferRef.current, finalWord].slice(-SPOKEN_BUFFER_SIZE);

    const bestMatch = findBestFuzzyMatch(spokenBufferRef.current, scriptTokens, cursorRef.current);

    if (!bestMatch || bestMatch.score < MATCH_THRESHOLD) {
      noMatchSinceRef.current = noMatchSinceRef.current || Date.now();
      return;
    }

    noMatchSinceRef.current = null;
    setIsOffScript(false);
    cursorRef.current = bestMatch.end;
    visualCursorRef.current = Math.max(visualCursorRef.current, bestMatch.end);
    setCursor(visualCursorRef.current);

    const matchedAt = Date.now();
    const measuredWpm = updateSpeakingPace(bestMatch.end, matchedAt);
    const activeWpm = measuredWpm || wpm || STARTUP_PREDICTIVE_WPM;

    maybeSafetyScrollNearLineEnd(visualCursorRef.current, activeWpm);
    schedulePredictiveScroll(bestMatch.end, activeWpm, matchedAt);
  }

  async function startSpeechRecognition() {
    const runId = (speechRunIdRef.current += 1);

    clearSpeechError();
    setFinalTranscript("");
    setInterimTranscript("");

    const provider = createSpeechProvider({
      apiKey: import.meta.env.DEEPGRAM_API_KEY || "",
      onStatus: setMicState,
      onError: showSpeechError,
      onToast: showToast,
    });
    providerRef.current = provider;

    unsubscribeWordRef.current = provider.onWord((event) => {
      if (event.isFinal) {
        setFinalTranscript((current) => `${current} ${event.word}`.trim());
        setInterimTranscript("");
        handleFinalWord(event.word);
        return;
      }

      const transcript = event.transcript || event.word;
      setInterimTranscript(transcript);
      handleInterimTranscript(transcript);
    });

    await provider.start();

    if (speechRunIdRef.current !== runId || providerRef.current !== provider) {
      provider.stop?.();
    }
  }

  function stopSpeechRecognition() {
    speechRunIdRef.current += 1;
    unsubscribeWordRef.current?.();
    unsubscribeWordRef.current = null;
    providerRef.current?.stop?.();
    providerRef.current = null;
    setMicState("paused", "Mic paused");
  }

  function pauseRecognition() {
    cancelPredictiveScroll();
    stopSpeechRecognition();
    setIsPaused(true);
  }

  function resumeRecognition() {
    setIsPaused(false);
    startSpeechRecognition();
  }

  function togglePause() {
    if (!isReading) {
      return;
    }

    if (isPaused) {
      resumeRecognition();
      return;
    }

    pauseRecognition();
  }

  function resetReadingPosition() {
    cancelPredictiveScroll();
    cursorRef.current = -1;
    visualCursorRef.current = -1;
    spokenBufferRef.current = [];
    interimSpokenBufferRef.current = [];
    matchPaceRef.current = [];
    noMatchSinceRef.current = null;
    offScriptToastShownRef.current = false;
    setCursor(0);
    setWpm(null);
    setIsOffScript(false);
    setFinalTranscript("");
    setInterimTranscript("");

    if (promptRef.current) {
      promptRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function restartFromTop() {
    resetReadingPosition();

    if (!isPaused) {
      stopSpeechRecognition();
      startSpeechRecognition();
    }
  }

  function startReading() {
    if (!script.trim()) {
      return;
    }

    tokenRefs.current = [];
    cursorRef.current = -1;
    visualCursorRef.current = -1;
    spokenBufferRef.current = [];
    interimSpokenBufferRef.current = [];
    matchPaceRef.current = [];
    noMatchSinceRef.current = null;
    offScriptToastShownRef.current = false;
    cancelPredictiveScroll();
    setCursor(0);
    setWpm(null);
    setIsOffScript(false);
    setIsPaused(false);
    setIsReading(true);

    window.requestAnimationFrame(() => {
      if (promptRef.current) {
        promptRef.current.scrollTop = 0;
      }
    });
  }

  function stopReading() {
    cancelPredictiveScroll();
    stopSpeechRecognition();
    setIsPaused(false);
    setIsReading(false);
  }

  useEffect(() => {
    if (!isReading) {
      return undefined;
    }

    startSpeechRecognition();

    return () => {
      cancelPredictiveScroll();
      stopSpeechRecognition();
    };
  }, [isReading]);

  useEffect(() => {
    if (!isReading) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (!noMatchSinceRef.current) {
        return;
      }

      const offScriptFor = Date.now() - noMatchSinceRef.current;
      setIsOffScript(offScriptFor > OFF_SCRIPT_DELAY_MS);

      if (offScriptFor > 10000 && !offScriptToastShownRef.current) {
        offScriptToastShownRef.current = true;
        showToast("Off-script for more than 10 seconds");
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [isReading]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 700px), (pointer: coarse)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);
    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);

    return () => {
      mediaQuery.removeEventListener("change", updateIsMobile);
    };
  }, []);

  useEffect(() => {
    if (!isReading || !promptRef.current) {
      return;
    }

    window.requestAnimationFrame(() => {
      scrollTokenIntoReadingLine(cursorRef.current, { onlyIfTooLow: true });
    });
  }, [fontSize, isReading]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (!isReading) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        togglePause();
      }

      if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        restartFromTop();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isReading, isPaused]);

  useEffect(() => {
    return () => {
      stopSpeechRecognition();
    };
  }, []);

  if (!isReading) {
    return (
      <main className="editor">
        <section className="editorShell" aria-labelledby="pageTitle">
          <div className="topBar">
            <div>
              <h1 id="pageTitle">Teleprompter</h1>
              <p className="hint">Paste your script, then start reading in a focused four-line view.</p>
            </div>
          </div>

          <textarea
            className="scriptInput"
            value={script}
            onChange={(event) => setScript(event.target.value)}
            spellCheck="true"
            placeholder="Paste or type your script here..."
          />

          <div className="actions">
            <button className="button" type="button" disabled={!script.trim()} onClick={startReading}>
              Start
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <section
      className="teleprompter"
      aria-label="Teleprompter view"
      onClick={(event) => {
        if (isMobile && event.target === event.currentTarget) {
          togglePause();
        }
      }}
    >
      <button className="button backButton" type="button" onClick={stopReading}>
        Back
      </button>

      <div className="teleprompterControls" onClick={(event) => event.stopPropagation()}>
        <label>
          <span>Font {fontSize}px</span>
          <input
            type="range"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
        </label>
        <button className="controlButton" type="button" onClick={togglePause}>
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button className="controlButton" type="button" onClick={restartFromTop}>
          Restart
        </button>
      </div>

      <div className="micHud" data-status={micStatus} aria-live="polite">
        <span className="micDot" aria-hidden="true" />
        <span>{isPaused ? "Paused" : micLabel}</span>
      </div>

      {isOffScript ? <div className="offScriptBadge">Off-script</div> : null}

      <div className="wpmReadout" aria-live="polite">
        {wpm ? `${wpm} WPM` : "-- WPM"}
      </div>

      {speechError ? (
        <div className="errorBanner isVisible" role="alert">
          {speechError}
        </div>
      ) : null}

      <div className="promptViewport">
        <p
          className="promptText"
          ref={promptRef}
          style={{
            "--prompt-font-size": `${fontSize}px`,
          }}
        >
          {promptParts.map((part) => {
            if (part.type !== "token") {
              return <Fragment key={part.id}>{part.text}</Fragment>;
            }

            return (
              <span
                className={part.tokenIndex === cursor ? "currentPosition" : undefined}
                key={part.id}
                ref={(element) => {
                  tokenRefs.current[part.tokenIndex] = element;
                }}
              >
                {part.text}
              </span>
            );
          })}
        </p>
      </div>

      <div className="wordFeed" aria-live="polite">
        <div className="wordFeedInner">
          <span className="wordFeedLabel">Live words</span>
          <span className="wordFeedWords">{liveWords.length ? liveWords.join(" ") : "Listening..."}</span>
        </div>
      </div>

      {isMobile ? <button className="tapPause" type="button" onClick={togglePause}>{isPaused ? "Tap to resume" : "Tap to pause"}</button> : null}

      <div className="toastStack" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
    </section>
  );
}

export default App;
