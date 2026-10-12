import React from "react";

interface Props { children: React.ReactNode; label?: string }
interface State { error: Error | undefined }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="access-login">
        <section className="access-card" role="alert">
          <h1>页面出现异常</h1>
          <p>{this.props.label ? `${this.props.label}渲染出错` : "页面渲染出错"}：{this.state.error.message}</p>
          <button className="button button-dark" onClick={() => this.setState({ error: undefined })}>重试本页</button>{" "}
          <button className="access-link" onClick={() => window.location.reload()}>重新加载页面</button>
        </section>
      </div>
    );
  }
}
