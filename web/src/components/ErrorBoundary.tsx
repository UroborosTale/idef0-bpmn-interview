import { Component, type ReactNode } from "react";

/**
 * Ошибка отрисовки в одной панели не должна ронять всё приложение: показываем сообщение
 * и даём повторить. resetKey — при его смене (переход на другую страницу/вкладку) ошибка сбрасывается.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Ошибка в интерфейсе", error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="validation-item error" role="alert">
        <b>Не удалось показать этот раздел.</b> {this.state.error.message}
        <div style={{ marginTop: 8 }}>
          <button onClick={() => this.setState({ error: null })}>Попробовать снова</button>
        </div>
      </div>
    );
  }
}
