import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import CommandRunner, { extractErrorLines } from './CommandRunner.jsx';
import { stream } from '../api.js';

vi.mock('../api.js', () => ({ stream: { commandRun: vi.fn() } }));

const chat = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock('../App.jsx', () => ({ ChatContext: { _currentValue: chat, _currentValue2: chat } }));

// Minimal stand-in for the SSE handle returned by stream.commandRun: it records
// the handlers CommandRunner assigns so tests can drive messages by hand.
function makeFakeEs() {
  const es = { handlers: {}, closed: false };
  Object.defineProperty(es, 'onmessage', { set(fn) { es.handlers.message = fn; } });
  Object.defineProperty(es, 'onerror', { set(fn) { es.handlers.error = fn; } });
  es.close = () => { es.closed = true; };
  return es;
}

let fakeEs;
beforeEach(() => {
  vi.clearAllMocks();
  fakeEs = makeFakeEs();
  stream.commandRun.mockReturnValue(fakeEs);
});

const emit = (payload) => act(() => fakeEs.handlers.message({ data: payload }));

describe('extractErrorLines', () => {
  it('collects lines matching error patterns', () => {
    const out = extractErrorLines([
      { text: 'all good' },
      { text: 'Deployment failed: nope' },
      { text: 'INVALID_FIELD: bad' },
    ]);
    expect(out).toEqual(['Deployment failed: nope', 'INVALID_FIELD: bad']);
  });

  it('caps the result at 8 lines', () => {
    const lines = Array.from({ length: 20 }, () => ({ text: 'FAILED' }));
    expect(extractErrorLines(lines)).toHaveLength(8);
  });
});

describe('CommandRunner', () => {
  it('renders an idle Run button', () => {
    render(<CommandRunner command="preflight" label="Preflight Check" />);
    expect(screen.getByRole('button', { name: /Run/i })).toBeInTheDocument();
  });

  it('streams log lines and completes on a zero exit code', () => {
    const onComplete = vi.fn();
    render(<CommandRunner command="preflight" label="Preflight Check" onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    expect(stream.commandRun).toHaveBeenCalledWith('preflight', {});
    expect(screen.getByText('running')).toBeInTheDocument();

    emit({ type: 'log', line: 'hello world' });
    expect(screen.getByText('hello world')).toBeInTheDocument();

    emit({ type: 'result', exitCode: 0 });
    expect(screen.getByText(/Complete/i)).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledWith(0);
    expect(fakeEs.closed).toBe(true);
  });

  it('shows a failure panel with extracted error lines on a non-zero exit', () => {
    render(<CommandRunner command="deploy" label="Deploy" />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    emit({ type: 'log', line: 'Deployment failed: boom' });
    emit({ type: 'result', exitCode: 1 });
    expect(screen.getAllByText(/Exit 1/i).length).toBeGreaterThan(0);
    // The line appears in both the terminal log and the failure panel.
    expect(screen.getAllByText('Deployment failed: boom').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Ask AI/i })).toBeInTheDocument();
  });

  it('forwards a failure summary to the chat when Ask AI is clicked', () => {
    render(<CommandRunner command="deploy" label="Deploy" />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    emit({ type: 'log', line: 'Deployment failed: boom' });
    emit({ type: 'result', exitCode: 1 });
    fireEvent.click(screen.getByRole('button', { name: /Ask AI/i }));
    expect(chat.openChat).toHaveBeenCalledTimes(1);
    expect(chat.openChat.mock.calls[0][0]).toContain('Deployment failed: boom');
  });

  it('falls into the error state on an error message', () => {
    render(<CommandRunner command="deploy" label="Deploy" />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    emit({ type: 'error' });
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('enters the error state when the stream errors', () => {
    render(<CommandRunner command="deploy" label="Deploy" />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    act(() => fakeEs.handlers.error());
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('resets back to idle when Run again is clicked', () => {
    render(<CommandRunner command="preflight" label="Preflight" />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    emit({ type: 'result', exitCode: 0 });
    fireEvent.click(screen.getByRole('button', { name: /Run again/i }));
    expect(screen.getByRole('button', { name: /^Run$/i })).toBeInTheDocument();
  });

  it('passes extra params through to the stream', () => {
    render(<CommandRunner command="audit" label="Audit" extraParams={{ check: 'mfa' }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    expect(stream.commandRun).toHaveBeenCalledWith('audit', { check: 'mfa' });
  });
});
