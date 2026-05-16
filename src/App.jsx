import { Fragment, useEffect, useMemo, useRef, useState } from "react";

const SPOKEN_BUFFER_SIZE = 8;
const SEARCH_WINDOW_SIZE = 12;
const MATCH_THRESHOLD = 0.55;
const OFF_SCRIPT_DELAY_MS = 4000;

function normalizeToken(token) {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function getLastWords(text, count) {
  return text.trim().split(/\s+/).filter(Boolean).slice(-count);
}

function getFinalWords(transcript) {
  return transcript.trim().split(/\s+/).map(normalizeToken).filter(Boolean);
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

  const promptRef = useRef(null);
  const tokenRefs = useRef([]);
  const cursorRef = useRef(-1);
  const spokenBufferRef = useRef([]);
  const noMatchSinceRef = useRef(null);
  const recognitionRef = useRef(null);
  const restartTimerRef = useRef(0);
  const shouldListenRef = useRef(false);
  const hasSpeechErrorRef = useRef(false);

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

  function showSpeechError(message) {
    hasSpeechErrorRef.current = true;
    setSpeechError(message);
    setMicState("error", "Mic error");
  }

  function clearSpeechError() {
    hasSpeechErrorRef.current = false;
    setSpeechError("");
  }

  function scrollMatchedTokenIntoReadingLine(index) {
    const prompt = promptRef.current;
    const tokenElement = tokenRefs.current[index];

    if (!prompt || !tokenElement) {
      return;
    }

    const styles = window.getComputedStyle(prompt);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const targetTop = tokenElement.offsetTop - lineHeight;
    const nextScrollTop = Math.max(0, targetTop);

    if (nextScrollTop <= prompt.scrollTop) {
      return;
    }

    prompt.scrollTo({
      top: nextScrollTop,
      behavior: "smooth",
    });
  }

  function handleFinalTranscript(transcript) {
    const finalWords = getFinalWords(transcript);

    if (!finalWords.length) {
      return;
    }

    spokenBufferRef.current = [...spokenBufferRef.current, ...finalWords].slice(-SPOKEN_BUFFER_SIZE);

    const bestMatch = findBestFuzzyMatch(spokenBufferRef.current, scriptTokens, cursorRef.current);

    if (!bestMatch || bestMatch.score < MATCH_THRESHOLD) {
      noMatchSinceRef.current = noMatchSinceRef.current || Date.now();
      return;
    }

    noMatchSinceRef.current = null;
    setIsOffScript(false);
    cursorRef.current = bestMatch.end;
    setCursor(bestMatch.end);
    scrollMatchedTokenIntoReadingLine(bestMatch.end);
  }

  function scheduleRecognitionRestart() {
    window.clearTimeout(restartTimerRef.current);

    if (!shouldListenRef.current || !recognitionRef.current) {
      return;
    }

    setMicState("paused", "Mic reconnecting");
    restartTimerRef.current = window.setTimeout(() => {
      if (!shouldListenRef.current || !recognitionRef.current) {
        return;
      }

      try {
        recognitionRef.current.start();
      } catch {
        scheduleRecognitionRestart();
      }
    }, 250);
  }

  function startSpeechRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    clearSpeechError();
    setFinalTranscript("");
    setInterimTranscript("");
    shouldListenRef.current = true;

    if (!Recognition) {
      shouldListenRef.current = false;
      showSpeechError(
        "Speech recognition is not supported in this browser. Try Chrome or Edge with microphone access enabled.",
      );
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      if (!shouldListenRef.current) {
        return;
      }

      clearSpeechError();
      setMicState("listening", "Mic listening");
    };

    recognition.onresult = (event) => {
      let nextInterim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0].transcript;

        if (result.isFinal) {
          setFinalTranscript((current) => `${current} ${transcript}`.trim());
          handleFinalTranscript(transcript);
        } else {
          nextInterim = `${nextInterim} ${transcript}`.trim();
        }
      }

      setInterimTranscript(nextInterim);
    };

    recognition.onerror = (event) => {
      if (!shouldListenRef.current) {
        return;
      }

      const recoverableErrors = new Set(["aborted", "network", "no-speech"]);

      if (recoverableErrors.has(event.error)) {
        setMicState("paused", "Mic reconnecting");
        return;
      }

      shouldListenRef.current = false;
      showSpeechError(`Microphone error: ${event.error}. Check browser permissions and try Start again.`);
    };

    recognition.onend = () => {
      if (shouldListenRef.current) {
        scheduleRecognitionRestart();
        return;
      }

      if (!hasSpeechErrorRef.current) {
        setMicState("paused", "Mic paused");
      }
    };

    try {
      recognition.start();
      setMicState("paused", "Mic starting");
    } catch {
      showSpeechError("Could not start microphone recognition. Check browser permissions and try again.");
    }
  }

  function stopSpeechRecognition() {
    shouldListenRef.current = false;
    window.clearTimeout(restartTimerRef.current);
    setMicState("paused", "Mic paused");

    const recognition = recognitionRef.current;

    if (!recognition) {
      return;
    }

    recognition.onend = null;

    try {
      recognition.stop();
    } catch {
      recognition.abort();
    }

    recognitionRef.current = null;
  }

  function startReading() {
    if (!script.trim()) {
      return;
    }

    tokenRefs.current = [];
    cursorRef.current = -1;
    spokenBufferRef.current = [];
    noMatchSinceRef.current = null;
    setCursor(0);
    setIsOffScript(false);
    setIsReading(true);

    window.requestAnimationFrame(() => {
      if (promptRef.current) {
        promptRef.current.scrollTop = 0;
      }
    });
  }

  function stopReading() {
    stopSpeechRecognition();
    setIsReading(false);
  }

  useEffect(() => {
    if (!isReading) {
      return undefined;
    }

    startSpeechRecognition();

    return () => {
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

      setIsOffScript(Date.now() - noMatchSinceRef.current > OFF_SCRIPT_DELAY_MS);
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [isReading]);

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
    <section className="teleprompter" aria-label="Teleprompter view">
      <button className="button backButton" type="button" onClick={stopReading}>
        Back
      </button>

      <div className="micHud" data-status={micStatus} aria-live="polite">
        <span className="micDot" aria-hidden="true" />
        <span>{micLabel}</span>
      </div>

      {isOffScript ? <div className="offScriptBadge">Off-script</div> : null}

      {speechError ? (
        <div className="errorBanner isVisible" role="alert">
          {speechError}
        </div>
      ) : null}

      <div className="promptViewport">
        <p className="promptText" ref={promptRef}>
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
    </section>
  );
}

export default App;
