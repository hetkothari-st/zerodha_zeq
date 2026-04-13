import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './auth/AuthContext.jsx'
import { installUserStorageShim } from './auth/userStorage.js'
import './index.css'

// Install the localStorage per-user namespace shim BEFORE any React code runs.
installUserStorageShim();

ReactDOM.createRoot(document.getElementById('root')).render(
    <AuthProvider>
        <App />
    </AuthProvider>
)
