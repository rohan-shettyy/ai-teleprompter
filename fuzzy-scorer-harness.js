(function runFuzzyScorerHarness() {
  const SPOKEN_BUFFER_SIZE = 8;
  const SEARCH_WINDOW_SIZE = 12;
  const MATCH_THRESHOLD = 0.55;

  function normalizeToken(token) {
    return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function tokenize(text) {
    return text.trim().split(/\s+/).map(normalizeToken).filter(Boolean);
  }

  function levenshteinDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    const current = Array(right.length + 1);

    for (let i = 1; i <= left.length; i += 1) {
      current[0] = i;

      for (let j = 1; j <= right.length; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      }

      previous.splice(0, previous.length, ...current);
    }

    return previous[right.length];
  }

  function similarityScore(left, right) {
    const leftText = left.join(" ");
    const rightText = right.join(" ");
    const longest = Math.max(leftText.length, rightText.length);
    return longest === 0 ? 1 : 1 - levenshteinDistance(leftText, rightText) / longest;
  }

  function findBestFuzzyMatch(spokenBuffer, scriptTokens, cursor) {
    const minEnd = cursor + 1;
    const maxEnd = Math.min(scriptTokens.length - 1, cursor + SEARCH_WINDOW_SIZE);
    let bestMatch = null;

    for (let end = minEnd; end <= maxEnd; end += 1) {
      const maxLength = Math.min(SPOKEN_BUFFER_SIZE, spokenBuffer.length, end + 1);
      const minLength = Math.max(1, Math.min(maxLength, spokenBuffer.length - 2));

      for (let length = minLength; length <= maxLength; length += 1) {
        const start = end - length + 1;
        const candidate = scriptTokens.slice(start, end + 1);
        const spoken = spokenBuffer.slice(-length);
        const score = similarityScore(spoken, candidate);

        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { start, end, score, spoken, candidate };
        }
      }
    }

    return bestMatch;
  }

  const script = tokenize(
    "Today we are launching a teleprompter that follows your voice and keeps the next line ready.",
  );

  const examples = [
    {
      name: "ad-lib at start",
      cursor: -1,
      spoken: "okay so today we are launching",
      expected: true,
    },
    {
      name: "rephrased middle",
      cursor: 4,
      spoken: "a prompting tool follows your voice",
      expected: true,
    },
    {
      name: "skipped words",
      cursor: 7,
      spoken: "keeps next line ready",
      expected: true,
    },
    {
      name: "minor misrecognition",
      cursor: 1,
      spoken: "are lunching a tele promptor",
      expected: true,
    },
    {
      name: "unrelated tangent",
      cursor: 4,
      spoken: "the weather outside is bright and sunny",
      expected: false,
    },
  ];

  const results = examples.map((example) => {
    const spokenBuffer = tokenize(example.spoken).slice(-SPOKEN_BUFFER_SIZE);
    const match = findBestFuzzyMatch(spokenBuffer, script, example.cursor);
    const passed = Boolean(match && match.score >= MATCH_THRESHOLD) === example.expected;

    return {
      name: example.name,
      score: Number((match ? match.score : 0).toFixed(3)),
      matched: Boolean(match && match.score >= MATCH_THRESHOLD),
      expected: example.expected,
      cursor: match ? match.end : null,
      candidate: match ? match.candidate.join(" ") : "",
      passed,
    };
  });

  console.table(results);

  if (!results.every((result) => result.passed)) {
    throw new Error("Fuzzy scorer harness failed.");
  }

  console.log("Fuzzy scorer harness passed.");
})();
