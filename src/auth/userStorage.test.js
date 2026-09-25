import { test, expect, afterEach } from 'vitest';
import { installUserStorageShim, setUserNamespace, migrateToUserNamespace } from './userStorage';

afterEach(() => { setUserNamespace(null); });

const allKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();

test('copies raw (pre-namespace) app keys into u:<id>:', () => {
    localStorage.setItem('mt_layout', 'A');
    localStorage.setItem('nifty_baseline', 'B');
    localStorage.setItem('funnel_claimed_session', 'not-an-app-key');
    migrateToUserNamespace('u1', 'a@b.in');
    expect(localStorage.getItem('u:u1:mt_layout')).toBe('A');
    expect(localStorage.getItem('u:u1:nifty_baseline')).toBe('B');
    expect(localStorage.getItem('u:u1:funnel_claimed_session')).toBeNull();
});

test('copies email-namespaced keys, stripping the prefix; they win over raw ones', () => {
    localStorage.setItem('mt_layout', 'raw');
    localStorage.setItem('u:a@b.in:mt_layout', 'email');
    localStorage.setItem('u:a@b.in:vl_cols', 'cols');
    localStorage.setItem('u:other@b.in:vl_x', 'someone-else');
    migrateToUserNamespace('u1', 'a@b.in');
    expect(localStorage.getItem('u:u1:mt_layout')).toBe('email');
    expect(localStorage.getItem('u:u1:vl_cols')).toBe('cols');
    expect(localStorage.getItem('u:u1:vl_x')).toBeNull();
});

test('the email prefix is sanitised the same way the namespace is', () => {
    localStorage.setItem('u:a_b@c.in:mt_x', 'v');
    migrateToUserNamespace('u1', 'a+b@c.in');
    expect(localStorage.getItem('u:u1:mt_x')).toBe('v');
});

test('no-op when the id namespace already has data', () => {
    localStorage.setItem('u:u1:mt_layout', 'current');
    localStorage.setItem('mt_layout', 'raw');
    localStorage.setItem('u:a@b.in:vl_cols', 'email');
    migrateToUserNamespace('u1', 'a@b.in');
    expect(localStorage.getItem('u:u1:mt_layout')).toBe('current');
    expect(localStorage.getItem('u:u1:vl_cols')).toBeNull();
});

test('deletes nothing', () => {
    localStorage.setItem('mt_layout', 'raw');
    localStorage.setItem('u:a@b.in:vl_cols', 'email');
    const before = allKeys();
    migrateToUserNamespace('u1', 'a@b.in');
    expect(allKeys()).toEqual([...before, 'u:u1:mt_layout', 'u:u1:vl_cols'].sort());
    expect(localStorage.getItem('mt_layout')).toBe('raw');
    expect(localStorage.getItem('u:a@b.in:vl_cols')).toBe('email');
});

test('uses the original Storage methods even with the shim installed and a namespace active', () => {
    installUserStorageShim();
    setUserNamespace(null);
    localStorage.setItem('mt_layout', 'raw'); // no namespace → stored under the raw key
    setUserNamespace('someone');
    migrateToUserNamespace('u1', null);
    setUserNamespace(null);
    expect(localStorage.getItem('u:u1:mt_layout')).toBe('raw');
    expect(localStorage.getItem('u:someone:u:u1:mt_layout')).toBeNull();
    expect(localStorage.getItem('u:someone:mt_layout')).toBeNull();
});
