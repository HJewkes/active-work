import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found in dashboard host page');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
