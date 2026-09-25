import React, { useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';
import SignIn from './screens/SignIn';
import SignUp from './screens/SignUp';
import ForgotPassword from './screens/ForgotPassword';
import ResetPassword from './screens/ResetPassword';
import AddEmail from './screens/AddEmail';
import VerifyEmail from './screens/VerifyEmail';
import AddMobile from './screens/AddMobile';
import Waitlist from './screens/Waitlist';
import Rejected from './screens/Rejected';
import LinkExpired from './screens/LinkExpired';
import Unavailable from './screens/Unavailable';
import Loading from './screens/Loading';

const BY_SCREEN = { resetPassword: ResetPassword, linkExpired: LinkExpired, addEmail: AddEmail, verifyEmail: VerifyEmail,
    addMobile: AddMobile, unavailable: Unavailable, rejected: Rejected, waitlist: Waitlist, loading: Loading };

export default function AuthScreens() {
    const { screen } = useAuth();
    const [view, setView] = useState('signIn');
    useEffect(() => { setView('signIn'); }, [screen]);
    if (screen === 'signIn') {
        if (view === 'signUp') return <SignUp onSwitch={setView} />;
        if (view === 'forgot') return <ForgotPassword onBack={() => setView('signIn')} />;
        return <SignIn onSwitch={setView} onForgot={() => setView('forgot')} />;
    }
    const Screen = BY_SCREEN[screen] || Loading;
    return <Screen />;
}
