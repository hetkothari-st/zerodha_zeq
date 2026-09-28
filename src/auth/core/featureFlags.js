// Mobile OTP verification is on hold during development until SMS/DLT is live.
// Flip VITE_REQUIRE_MOBILE=true (build-time) to re-enable the addMobile gate.
export const REQUIRE_MOBILE = import.meta.env.VITE_REQUIRE_MOBILE === 'true';
