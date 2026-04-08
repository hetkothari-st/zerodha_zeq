import React from 'react'
import ReactDOM from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import App from './App.jsx'
import { AuthProvider } from './auth/AuthContext.jsx'
import { installUserStorageShim } from './auth/userStorage.js'
import './index.css'

// Install the localStorage per-user namespace shim BEFORE any React code runs.
// This way every subsequent get/set/remove on mt_*, vl_*, or nifty_baseline*
// keys is transparently rewritten to `u:<email>:<key>` based on the active
// user (set via setUserNamespace() in AuthContext).
installUserStorageShim();

// Google Cloud project: "Smarttouch Funnel EQ"
// Remember to add the deployed origin (e.g. https://funnel-eq.up.railway.app
// or https://funnel-eq.railway.app once the custom domain is attached) as an
// "Authorized JavaScript origin" on this OAuth client in the Google Cloud
// console — the sign-in popup will refuse to load otherwise.
const GOOGLE_CLIENT_ID =
    '1004311806000-iq31p48u3pfug25ir4k4egd43af3rn7r.apps.googleusercontent.com';

ReactDOM.createRoot(document.getElementById('root')).render(
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <AuthProvider>
            <App />
        </AuthProvider>
    </GoogleOAuthProvider>
)
