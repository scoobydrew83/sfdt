import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, textAlign: 'center' }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Something went wrong</p>
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginBottom: 16 }}>
            {this.state.error.message}
          </p>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
