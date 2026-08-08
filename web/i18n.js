(() => {
  'use strict';
  const KEY = 'duet_language';
  const copy = {
    en: {
      how: 'How it works', people: 'People', login: 'Log in', logout: 'Log out',
      hero: 'Press play <em>together</em>.',
      heroBody: "Stay on the same frame—even when you're miles apart. You each stream from your own account; Duet only carries the timing.",
      start: 'Start a room', join: 'Join with a code', roomCode: 'Room code', codePlaceholder: 'Enter 6-letter code', console: 'Open console', tv: 'Open on TV',
      howTitle: 'One shared moment. Three simple steps.', howBody: 'Duet works with what you already watch. Your video never passes through us.',
      s1: 'Open what you already watch', s1b: 'Each person streams from their own account in Chrome. Duet never copies or relays the movie.',
      s2: 'Pair your screens', s2b: 'Use two laptops, a laptop and TV, or two TVs with the companion controls.',
      s3: 'Stay on the same frame', s3b: 'Play, pause, seek, and countdown cues keep both sides together down to a fraction of a second.',
      setup: 'Your setup', ready: 'Ready when you are.', readyBody: 'Check the extension, choose your name, then create or join a room.',
      ext: 'Browser extension', extTitle: 'Get the extension', yourName: 'Your name', nameBody: 'This is how you appear in the room and chat. You only set it once.', save: 'Save name',
      createTitle: 'Start a room', createBody: "You'll receive a six-letter code and a link to share.", create: 'Create a room',
      joinTitle: 'Join a room', joinBody: 'Use the room code you received, then choose the screen you want to control.',
      devices: 'Choose your screen setup', ll: 'Laptop ↔ Laptop', llb: 'Install the extension on both computers for automatic play, pause, and seek.',
      lt: 'Laptop ↔ TV', ltb: 'Use HDMI or cast a browser tab for the simplest full-screen setup.', tt: 'TV ↔ TV', ttb: 'Use the TV companion or local device helper for countdowns and corrections.',
      privacy: 'Duet never copies, relays, or re-streams video. Both people need their own access to what they are watching.',
      back: 'Back to home', loginHero: 'Our next watch is <em>waiting</em>.', loginSub: 'Pick up where you left off—together.', invite: 'Invite only', welcome: 'Welcome back.', loginIntro: 'Log in to start or join a room.',
      email: 'Email', password: 'Password', show: 'Show password', hide: 'Hide password', loginButton: 'Log in', invited: 'Only invited people can use this Duet.',
      invalidCode: 'Enter a valid room code.', creating: 'Creating your room…', createError: 'Could not create the room. Please try again.',
      loginBusy: 'Logging in…', invalidLogin: 'Invalid email or password.', attempts: 'Too many attempts. Wait a few minutes.', disabled: 'This account is disabled. Ask the owner to enable it.'
    },
    bn: {
      how: 'কীভাবে কাজ করে', people: 'সদস্যরা', login: 'লগ ইন', logout: 'লগ আউট',
      hero: 'চলো, একসঙ্গে <em>প্লে চাপি</em>।',
      heroBody: 'দূরে থেকেও একই দৃশ্য, একই মুহূর্তে। ভিডিও থাকবে আপনাদের নিজস্ব অ্যাকাউন্টে—ডুয়েট শুধু সময়টা মিলিয়ে রাখে।',
      start: 'রুম শুরু করুন', join: 'কোড দিয়ে যোগ দিন', roomCode: 'রুম কোড', codePlaceholder: '৬ অক্ষরের কোড লিখুন', console: 'কনসোল খুলুন', tv: 'টিভিতে খুলুন',
      howTitle: 'এক মুহূর্ত, একসঙ্গে। মাত্র তিনটি ধাপ।', howBody: 'আপনারা যা দেখেন, ডুয়েট সেটার সঙ্গেই কাজ করে। ভিডিও কখনোই আমাদের কাছে আসে না।',
      s1: 'নিজের পছন্দের ভিডিও খুলুন', s1b: 'দুজনেই Chrome-এ নিজের অ্যাকাউন্ট থেকে দেখবেন। ডুয়েট সিনেমা কপি বা রিলে করে না।',
      s2: 'স্ক্রিন দুটো জুড়ে দিন', s2b: 'দুটি ল্যাপটপ, একটি ল্যাপটপ ও টিভি, অথবা দুটি টিভি—যেভাবে সুবিধা।',
      s3: 'একই ফ্রেমে থাকুন', s3b: 'প্লে, পজ, সিক আর কাউন্টডাউন—দুই পাশকে একই মুহূর্তে ধরে রাখে।',
      setup: 'আপনার সেটআপ', ready: 'আপনি তৈরি হলেই শুরু।', readyBody: 'এক্সটেনশন দেখে নিন, নাম ঠিক করুন, তারপর রুম শুরু করুন অথবা যোগ দিন।',
      ext: 'ব্রাউজার এক্সটেনশন', extTitle: 'এক্সটেনশন নিন', yourName: 'আপনার নাম', nameBody: 'রুম ও চ্যাটে এই নামটিই দেখা যাবে। একবারই ঠিক করতে হবে।', save: 'নাম সেভ করুন',
      createTitle: 'রুম শুরু করুন', createBody: 'শেয়ার করার জন্য ছয় অক্ষরের একটি কোড ও লিংক পাবেন।', create: 'রুম তৈরি করুন',
      joinTitle: 'রুমে যোগ দিন', joinBody: 'পাওয়া রুম কোডটি লিখে কোন স্ক্রিন নিয়ন্ত্রণ করবেন তা বেছে নিন।',
      devices: 'আপনার স্ক্রিন সেটআপ বেছে নিন', ll: 'ল্যাপটপ ↔ ল্যাপটপ', llb: 'দুই কম্পিউটারেই এক্সটেনশন বসালে প্লে, পজ ও সিক নিজে থেকেই মিলবে।',
      lt: 'ল্যাপটপ ↔ টিভি', ltb: 'সহজ বড় পর্দার অভিজ্ঞতার জন্য HDMI বা ব্রাউজার ট্যাব কাস্ট করুন।', tt: 'টিভি ↔ টিভি', ttb: 'কাউন্টডাউন ও সংশোধনের জন্য টিভি কনসোল বা ডিভাইস হেলপার ব্যবহার করুন।',
      privacy: 'ডুয়েট কখনো ভিডিও কপি, রিলে বা পুনঃস্ট্রিম করে না। দুজনেরই নিজেদের দেখার অনুমতি থাকতে হবে।',
      back: 'হোমে ফিরুন', loginHero: 'মুভিটা তাহলে <em>হয়েই যাক</em>।', loginSub: 'যেখান থেকে থেমেছিলাম, সেখান থেকেই—একসঙ্গে।', invite: 'শুধু আমন্ত্রিতদের জন্য', welcome: 'আবার স্বাগতম।', loginIntro: 'রুম শুরু করতে বা যোগ দিতে লগ ইন করুন।',
      email: 'ইমেইল', password: 'পাসওয়ার্ড', show: 'পাসওয়ার্ড দেখুন', hide: 'পাসওয়ার্ড লুকান', loginButton: 'লগ ইন', invited: 'কেবল আমন্ত্রিতরাই এই ডুয়েট ব্যবহার করতে পারবেন।',
      invalidCode: 'সঠিক রুম কোড লিখুন।', creating: 'রুম তৈরি হচ্ছে…', createError: 'রুম তৈরি করা যায়নি। আবার চেষ্টা করুন।',
      loginBusy: 'লগ ইন হচ্ছে…', invalidLogin: 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।', attempts: 'অনেকবার চেষ্টা করা হয়েছে। কয়েক মিনিট অপেক্ষা করুন।', disabled: 'এই অ্যাকাউন্টটি বন্ধ আছে। মালিককে চালু করতে বলুন।'
    }
  };
  let language = localStorage.getItem(KEY) || (navigator.language?.toLowerCase().startsWith('bn') ? 'bn' : 'en');
  if (!copy[language]) language = 'en';
  const t = (key) => copy[language][key] || copy.en[key] || key;
  function apply() {
    document.documentElement.lang = language;
    document.documentElement.classList.toggle('lang-bn', language === 'bn');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-lang]').forEach((el) => { const active = el.dataset.lang === language; el.classList.toggle('is-active', active); el.setAttribute('aria-pressed', String(active)); });
    dispatchEvent(new CustomEvent('duet:languagechange', { detail: { language } }));
  }
  document.addEventListener('click', (event) => { const button = event.target.closest('[data-lang]'); if (!button) return; language = button.dataset.lang; localStorage.setItem(KEY, language); apply(); });
  window.DuetI18n = { t, apply, get language() { return language; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true }); else apply();
})();
