import { useState, useEffect, useRef, useCallback } from 'react';
import { streamChatMessage } from '../api.js';

const DRAWER_WIDTH = 420;

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 1100,
    pointerEvents: 'none',
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.2)',
    zIndex: 1099,
    animation: 'fadeIn 180ms cubic-bezier(.16,1,.3,1)',
  },
  drawer: (isOpen) => ({
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: `${DRAWER_WIDTH}px`,
    background: 'var(--bg-surface)',
    borderLeft: '1px solid var(--border-subtle)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 1100,
    display: 'flex',
    flexDirection: 'column',
    transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 280ms cubic-bezier(.16,1,.3,1)',
    pointerEvents: 'auto',
  }),
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-subtle)',
    flexShrink: 0,
    background: 'var(--bg-surface)',
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: '14px',
    color: 'var(--fg-default)',
    letterSpacing: '-0.01em',
  },
  pageChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: '9999px',
    background: 'var(--brand-50)',
    border: '1px solid var(--brand-200)',
    color: 'var(--brand-700)',
    fontSize: '11px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  headerSpacer: { flex: 1 },
  closeBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: '6px',
    border: 'none',
    background: 'transparent',
    color: 'var(--fg-muted)',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--border-default) transparent',
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 20px',
  },
  emptyInner: {
    textAlign: 'center',
    maxWidth: '280px',
  },
  emptyIcon: {
    width: '40px',
    height: '40px',
    borderRadius: '12px',
    background: 'var(--bg-muted)',
    display: 'grid',
    placeItems: 'center',
    margin: '0 auto 16px',
  },
  emptyText: {
    fontSize: '13px',
    color: 'var(--fg-muted)',
    lineHeight: 1.5,
    margin: 0,
  },
  messageBubble: (isUser) => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: isUser ? 'flex-end' : 'flex-start',
    gap: '4px',
  }),
  bubbleInner: (isUser) => ({
    maxWidth: '88%',
    padding: '8px 12px',
    borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
    background: isUser ? 'var(--brand-500)' : 'var(--bg-subtle)',
    border: isUser ? 'none' : '1px solid var(--border-subtle)',
    color: isUser ? '#fff' : 'var(--fg-default)',
    fontSize: '13px',
    lineHeight: 1.5,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  }),
  bubbleRole: (isUser) => ({
    fontSize: '11px',
    color: 'var(--fg-subtle)',
    fontWeight: 500,
    paddingLeft: isUser ? 0 : '4px',
    paddingRight: isUser ? '4px' : 0,
  }),
  cursor: {
    display: 'inline-block',
    animation: 'blink 1s step-end infinite',
    fontWeight: 400,
    marginLeft: '1px',
  },
  inputArea: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
    flexShrink: 0,
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    lineHeight: 1.5,
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-app)',
    color: 'var(--fg-default)',
    resize: 'none',
    outline: 'none',
    minHeight: '56px',
  },
  sendBtn: (disabled) => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    fontWeight: 500,
    padding: '8px 14px',
    borderRadius: '6px',
    border: '1px solid transparent',
    background: disabled ? 'var(--brand-300)' : 'var(--brand-500)',
    color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
    flexShrink: 0,
    alignSelf: 'flex-end',
    height: '36px',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 120ms, opacity 120ms',
  }),
  hint: {
    fontSize: '11px',
    color: 'var(--fg-subtle)',
    marginTop: '6px',
    textAlign: 'right',
    fontFamily: 'var(--font-mono)',
  },
};

export default function ChatDrawer({ isOpen, onClose, pageContext, messages, onMessagesChange }) {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);
  const textareaRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Focus textarea when drawer opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Abort in-flight stream when drawer closes or component unmounts
  useEffect(() => {
    if (!isOpen && abortRef.current) {
      abortRef.current();
      abortRef.current = null;
      setIsStreaming(false);
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current();
      }
    };
  }, []);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput('');

    const userMsg = { role: 'user', content: text };
    const assistantMsg = { role: 'assistant', content: '', streaming: true };
    const nextMessages = [...messages, userMsg, assistantMsg];
    onMessagesChange(nextMessages);

    setIsStreaming(true);

    let localMessages = nextMessages;

    const abort = streamChatMessage(
      // Send conversation history (excluding the empty streaming placeholder)
      [...messages, userMsg],
      pageContext,
      // onChunk
      (chunk) => {
        localMessages = localMessages.map((m, i) =>
          i === localMessages.length - 1
            ? { ...m, content: m.content + chunk }
            : m
        );
        onMessagesChange([...localMessages]);
      },
      // onDone
      () => {
        localMessages = localMessages.map((m, i) =>
          i === localMessages.length - 1 ? { ...m, streaming: false } : m
        );
        onMessagesChange([...localMessages]);
        setIsStreaming(false);
        abortRef.current = null;
      },
      // onError
      (errMsg) => {
        const errorContent = `Error: ${errMsg}`;
        localMessages = localMessages.map((m, i) =>
          i === localMessages.length - 1
            ? { ...m, content: errorContent, streaming: false }
            : m
        );
        onMessagesChange([...localMessages]);
        setIsStreaming(false);
        abortRef.current = null;
      }
    );

    abortRef.current = abort;
  }, [input, isStreaming, messages, onMessagesChange, pageContext]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [onClose, handleSubmit]);

  const pageName = pageContext?.page || 'this page';
  const hasMessages = messages && messages.length > 0;

  return (
    <>
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        .chat-textarea:focus {
          border-color: var(--brand-500) !important;
          box-shadow: 0 0 0 3px rgba(106,98,245,.25);
        }
        .chat-close-btn:hover {
          background: var(--bg-muted) !important;
          color: var(--fg-default) !important;
        }
        .chat-send-btn:not(:disabled):hover {
          background: var(--brand-600) !important;
        }
      `}</style>

      {isOpen && (
        <div style={styles.backdrop} onClick={onClose} />
      )}

      <div style={styles.drawer(isOpen)} role="complementary" aria-label="AI Assistant">
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.headerTitle}>AI Assistant</span>
          {pageName && (
            <span style={styles.pageChip} title={pageName}>
              {pageName}
            </span>
          )}
          <div style={styles.headerSpacer} />
          <button
            className="chat-close-btn"
            style={styles.closeBtn}
            onClick={onClose}
            aria-label="Close AI Assistant"
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M11.7816 4.03157C12.0062 3.80702 12.0062 3.44295 11.7816 3.2184C11.5571 2.99385 11.193 2.99385 10.9685 3.2184L7.50005 6.68682L4.03164 3.2184C3.80708 2.99385 3.44301 2.99385 3.21846 3.2184C2.99391 3.44295 2.99391 3.80702 3.21846 4.03157L6.68688 7.49999L3.21846 10.9684C2.99391 11.193 2.99391 11.557 3.21846 11.7816C3.44301 12.0061 3.80708 12.0061 4.03164 11.7816L7.50005 8.31316L10.9685 11.7816C11.193 12.0061 11.5571 12.0061 11.7816 11.7816C12.0062 11.557 12.0062 11.193 11.7816 10.9684L8.31322 7.49999L11.7816 4.03157Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Message list or empty state */}
        {!hasMessages ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyInner}>
              <div style={styles.emptyIcon}>
                <svg width="18" height="18" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ color: 'var(--fg-subtle)' }}>
                  <path d="M12.5 3L2.5 3.00002C1.67157 3.00002 1 3.6716 1 4.50002V9.50002C1 10.3285 1.67157 11 2.5 11H7.50003L10 13.5V11H12.5C13.3284 11 14 10.3285 14 9.50002V4.5C14 3.67157 13.3284 3 12.5 3ZM2.5 4.00002L12.5 4C12.7761 4 13 4.22386 13 4.5V9.50002C13 9.77617 12.7761 10 12.5 10H9V12.0858L7.29292 10.3787L7.08579 10H2.5C2.22386 10 2 9.77617 2 9.50002V4.50002C2 4.22388 2.22386 4.00002 2.5 4.00002Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
                </svg>
              </div>
              <p style={styles.emptyText}>
                Ask me about <strong>{pageName}</strong> results, deployment errors, or next steps.
              </p>
            </div>
          </div>
        ) : (
          <div style={styles.messageList}>
            {messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              return (
                <div key={idx} style={styles.messageBubble(isUser)}>
                  <span style={styles.bubbleRole(isUser)}>
                    {isUser ? 'You' : 'AI'}
                  </span>
                  <div style={styles.bubbleInner(isUser)}>
                    {msg.content}
                    {msg.streaming && (
                      <span style={styles.cursor} aria-hidden="true">▊</span>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input area */}
        <div style={styles.inputArea}>
          <div style={styles.inputRow}>
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              style={styles.textarea}
              rows={2}
              placeholder="Ask a question…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              aria-label="Chat input"
            />
            <button
              className="chat-send-btn"
              style={styles.sendBtn(!input.trim() || isStreaming)}
              onClick={handleSubmit}
              disabled={!input.trim() || isStreaming}
              aria-label="Send message"
            >
              {isStreaming ? (
                <span style={{
                  width: '12px', height: '12px',
                  border: '1.5px solid rgba(255,255,255,.4)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin .7s linear infinite',
                  display: 'inline-block',
                }} />
              ) : (
                <svg width="13" height="13" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1.20308 1.04312C1.00481 0.954998 0.772341 1.0048 0.627577 1.16641C0.482813 1.32802 0.458794 1.56455 0.568117 1.75196L3.92115 7.50002L0.568117 13.2481C0.458794 13.4355 0.482813 13.672 0.627577 13.8336C0.772341 13.9952 1.00481 14.045 1.20308 13.9569L14.7031 7.95693C14.8836 7.87668 15 7.69762 15 7.50002C15 7.30243 14.8836 7.12337 14.7031 7.04312L1.20308 1.04312ZM4.84553 7.10002L2.21234 2.586L13.2689 7.50002L2.21234 12.414L4.84553 7.90002H9C9.27614 7.90002 9.5 7.67616 9.5 7.40002C9.5 7.12388 9.27614 6.90002 9 6.90002H4.84553V7.10002Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
                </svg>
              )}
              Send
            </button>
          </div>
          <div style={styles.hint}>Ctrl+Enter to send · Esc to close</div>
        </div>
      </div>
    </>
  );
}
