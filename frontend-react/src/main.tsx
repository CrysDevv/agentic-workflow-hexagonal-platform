import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

// El backend limita a 60 solicitudes/min por IP: se evitan reconsultas innecesarias.
const cliente = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 2_000 },
    mutations: { retry: false },
  },
});

const raiz = document.getElementById('raiz');
if (raiz === null) {
  throw new Error('No se encontró el elemento #raiz');
}

createRoot(raiz).render(
  <StrictMode>
    <QueryClientProvider client={cliente}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
