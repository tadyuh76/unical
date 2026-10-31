import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { load } from "./store";
import "./globals.css";

// What UniCal knows is read before the first paint, so the popup opens straight into the right view.
load().then((initial) =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App initial={initial} />
    </React.StrictMode>
  )
);
