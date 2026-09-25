import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import Root from './Root.jsx';
import { AuthProvider } from './auth/AuthProvider';
import { installUserStorageShim } from './auth/userStorage';
import './index.css';

// Per-user localStorage namespace must be active before any component reads settings.
installUserStorageShim();

ReactDOM.createRoot(document.getElementById('root')).render(
    <AuthProvider>
        <Root App={App} />
    </AuthProvider>
);
