// The web address where this planner is published. Used to make the "use it on your phone" link
// when the planner is running on a computer's own address (localhost), which a phone cannot reach.
export const PUBLIC_URL = 'https://app.weftday.crckd.live/';
// The address this planner was published at before (see movein.js): things saved in a browser there
// can be handed across to the address above. A copy published somewhere else can leave this as it is.
export const MOVED_FROM = 'https://crckdteam.github.io';
// While true, a browser at the address above that has no Google sign-in setup yet is asked to request
// an invite when it tries to connect a calendar. A copy at any other address is never asked, so if you
// host your own copy you can leave this as it is, or set it to false.
export const INVITE_ONLY = true;
// Where invite requests go: shown in the "Request access" box. Put your own here if you host a copy
// and want people to ask you. whatsapp is the number with its country code, no "+" and no spaces.
export const CONTACT = { email: 'crckdteam@gmail.com', whatsapp: '917678644599', whatsappShown: '+91 76786 44599' };
