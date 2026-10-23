import RuntimeUpdateNotice from "./components/RuntimeUpdateNotice";
import ErrorBoundary from "./components/ErrorBoundary";
import React from "react";
import ReactDOM from "react-dom/client";
import Application from "./Application";
import "./styles.css";
import "./styles/studio-client.css";
import "./styles/gate.css";
import "./styles/service-page.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary label="应用外壳">
      <RuntimeUpdateNotice />
      <Application />
    </ErrorBoundary>
  </React.StrictMode>,
);
