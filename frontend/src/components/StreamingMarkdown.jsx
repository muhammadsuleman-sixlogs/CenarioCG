import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";

export default function StreamingMarkdown({
  content,
  isStreaming,
  onComplete
}) {
  const [displayedText, setDisplayedText] = useState(isStreaming ? "" : (content || ""));
  const [isTyping, setIsTyping] = useState(Boolean(isStreaming));
  const completeRef = useRef(onComplete);

  useEffect(() => {
    completeRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (!isStreaming) {
      const resetTimer = window.setTimeout(() => {
        setDisplayedText(content || "");
        setIsTyping(false);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }

    const fullText = content || "";
    const totalLength = fullText.length;
    if (totalLength === 0) {
      const completeTimer = window.setTimeout(() => {
        setIsTyping(false);
        if (completeRef.current) completeRef.current();
      }, 0);
      return () => window.clearTimeout(completeTimer);
    }

    const startTimer = window.setTimeout(() => {
      setDisplayedText("");
      setIsTyping(true);
    }, 0);

    let currentIndex = 0;
    // Typing speed calculation:
    // Scale chunk size dynamically so short messages (~100 chars) take ~0.8s,
    // medium messages (~500 chars) take ~1.5s, long messages take ~2.2s.
    // This gives an authentic, fluid AI streaming appearance without feeling sluggish.
    const chunkSize = Math.max(3, Math.ceil(totalLength / 55));
    const intervalMs = 18;

    const timer = setInterval(() => {
      currentIndex += chunkSize;
      if (currentIndex >= totalLength) {
        setDisplayedText(fullText);
        setIsTyping(false);
        clearInterval(timer);
        if (completeRef.current) {
          completeRef.current();
        }
      } else {
        setDisplayedText(fullText.slice(0, currentIndex));
      }
    }, intervalMs);

    return () => {
      window.clearTimeout(startTimer);
      clearInterval(timer);
    };
  }, [content, isStreaming]);

  return (
    <div className="streaming-markdown-body">
      <ReactMarkdown>{displayedText}</ReactMarkdown>
      {isTyping && (
        <span className="streaming-cursor" aria-hidden="true">
          ▋
        </span>
      )}
    </div>
  );
}
