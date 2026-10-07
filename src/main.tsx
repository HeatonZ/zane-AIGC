import RuntimeUpdateNotice from "./components/RuntimeUpdateNotice";
import React from "react";
import ReactDOM from "react-dom/client";
import Application from "./Application";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RuntimeUpdateNotice />
    <Application />
  </React.StrictMode>,
);

