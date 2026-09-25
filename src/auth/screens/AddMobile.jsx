import React from 'react';
import { useAuth } from '../AuthProvider';
import { Title, TextButton } from '../ui';
import PhoneOtpForm from '../PhoneOtpForm';

export default function AddMobile() {
    const auth = useAuth();
    return (
        <div className="flex flex-col gap-4">
            <Title title="Add your mobile" subtitle="We'll text you a 6-digit code. Your number keeps your account secure." />
            <PhoneOtpForm idPrefix="addmobile"
                sendCode={(phone) => auth.startAddMobile(phone)}
                verifyCode={(phone, c) => auth.verifyAddMobile(phone, c)} />
            <TextButton onClick={() => auth.signOut()}>Sign out</TextButton>
        </div>
    );
}
