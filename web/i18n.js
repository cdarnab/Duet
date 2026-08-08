(() => {
  'use strict';

  const STORAGE_KEY = 'duet_language';
  const dictionaries = {
    en: {
      navHow: 'How it works',
      navPeople: 'People',
      navLogin: 'Log in',
      navLogout: 'Log out',
      heroTitle: 'Press play <em>together</em>.',
      heroLede: "Stay on the same frame—even when you're miles apart. You each stream from your own account; Duet only carries the timing.",
      startRoom: 'Start a room',
      joinWithCode: 'Join with a code',
      roomCode: 'Room code',
      roomCodePlaceholder: 'Enter 6-letter code',
      openConsole: 'Open console',
      openTv: 'Open on TV',
      scrollBegin: 'Scroll to discover',
      howKicker: 'How it works',
      howTitle: 'One shared moment. Three simple steps.',
      howLede: 'Duet works with what you already watch. Your video never passes through us.',
      stepOneTitle: 'Open what you already watch',
      stepOneBody: 'Each person streams from their own account in Chrome. Duet never copies or relays the movie.',
      stepTwoTitle: 'Pair your screens',
      stepTwoBody: 'Use two laptops, a laptop and TV, or two TVs with the companion controls.',
      stepThreeTitle: 'Stay on the same frame',
      stepThreeBody: 'Play, pause, seek, and countdown cues keep both sides together down to a fraction of a second.',
      setupKicker: 'Your setup',
      setupTitle: 'Ready when you are.',
      setupLede: 'Check the extension, choose your name, then create or join a room.',
      extensionKicker: 'Browser extension',
      extensionTitle: 'Get the extension',
      installExtension: 'Install extension',
      profileTitle: 'Your name',
      profileBody: 'This is how you appear in the room and chat. You only set it once.',
      saveName: 'Save name',
      createTitle: 'Start a room',
      createBody: "You'll receive a six-letter code and a link to share.",
      createRoom: 'Create a room',
      joinTitle: 'Join a room',
      joinBody: 'Use the room code you received, then choose the screen you want to control.',
      deviceTitle: 'Choose your screen setup',
      laptopLaptop: 'Laptop ↔ Laptop',
      laptopLaptopBody: 'Install the browser extension on both computers for automatic play, pause, and seek.',
      laptopTv: 'Laptop ↔ TV',
      laptopTvBody: 'Use HDMI or cast a browser tab for the simplest full-screen setup.',
      tvTv: 'TV ↔ TV',
      tvTvBody: 'Use the TV companion or local device helper for countdowns, timecode, and corrections.',
      detailsLabel: 'Advanced TV setup details',
      privacyNote: 'Duet never copies, relays, or re-streams video. Both people need their own access to what they are watching.',
      authRequired: 'Log in to continue.',
      invalidCode: 'Enter a valid room code.',
      creatingRoom: 'Creating your room…',
      roomError: 'Could not create the room. Please try again.',
      checkingMac: 'Checking this Mac…',
      loginBack: 'Back to home',
      loginHeadline: 'Our next watch is <em>waiting</em>.',
      loginSubhead: 'Pick up where you left off—together.',
      inviteOnly: 'Invite only',
      welcomeBack: 'Welcome back.',
      loginIntro: 'Log in to start or join a room.',
      email: 'Email',
      password: 'Password',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      loginButton: 'Log in',
      invitedOnly: 'Only invited people can use this Duet.',
      tooManyAttempts: 'Too many attempts. Wait a few minutes.',
      disabledAccount: 'This account is disabled. Ask the owner to enable it.',
      invalidLogin: 'Invalid email or password.',
      loggingIn: 'Logging in…',
    },
    bn: {
      navHow: 'কীভাবে কাজ করে',
      navPeople: 'সদস্যরা',
      navLogin: 'লগ ইন',
      navLogout: 'লগ আউট',
      heroTitle: 'চলো, একসঙ্গে <em>প্লে চাপি</em>।',
      heroLede: 'দূরে থেকেও একই দৃশ্য, একই মুহূর্তে। ভিডিও থাকবে আপনাদের নিজস্ব অ্যাকাউন্টে—ডুয়েট শুধু সময়টা মিলিয়ে রাখে।',
      startRoom: 'রুম শুরু করুন',
      joinWithCode: 'কোড দিয়ে যোগ দিন',
      roomCode: 'রুম কোড',
      roomCodePlaceholder: '৬ অক্ষরের কোড লিখুন',
      openConsole: 'কনসোল খুলুন',
      openTv: 'টিভিতে খুলুন',
      scrollBegin: 'আরও জানতে স্ক্রল করুন',
      howKicker: 'যেভাবে কাজ করে',
      howTitle: 'এক মুহূর্ত, একসঙ্গে। মাত্র তিনটি ধাপ।',
      howLede: 'আপনারা যা দেখেন, ডুয়েট সেটার সঙ্গেই কাজ করে। ভিডিও কখনোই আমাদের কাছে আসে না।',
      stepOneTitle: 'নিজের পছন্দের ভিডিও খুলুন',
      stepOneBody: 'দুজনেই Chrome-এ নিজের অ্যাকাউন্ট থেকে দেখবেন। ডুয়েট সিনেমা কপি বা রিলে করে না।',
      stepTwoTitle: 'স্ক্রিন দুটো জুড়ে দিন',
      stepTwoBody: 'দুটি ল্যাপটপ, একটি ল্যাপটপ ও টিভি, অথবা দুটি টিভি—যেভাবে সুবিধা।',
      stepThreeTitle: 'একই ফ্রেমে থাকুন',
      stepThreeBody: 'প্লে, পজ, সিক আর কাউন্টডাউন—দুই পাশকে একই মুহূর্তে ধরে রাখে।',
      setupKicker: 'আপনার সেটআপ',
      setupTitle: 'আপনি তৈরি হলেই শুরু।',
      setupLede: 'এক্সটেনশন দেখে নিন, নাম ঠিক করুন, তারপর রুম শুরু করুন অথবা যোগ দিন।',
      extensionKicker: 'ব্রাউজার এক্সটেনশন',
      extensionTitle: 'এক্সটেনশন নিন',
      installExtension: 'এক্সটেনশন ইনস্টল করুন',
      profileTitle: 'আপনার নাম',
      profileBody: 'রুম ও চ্যাটে এই নামটিই দেখা যাবে। একবারই ঠিক করতে হবে।',
      saveName: 'নাম সেভ করুন',
      createTitle: 'রুম শুরু করুন',
      createBody: 'শেয়ার করার জন্য ছয় অক্ষরের একটি কোড ও লিংক পাবেন।',
      createRoom: 'রুম তৈরি করুন',
      joinTitle: 'রুমে যোগ দিন',
      joinBody: 'পাওয়া রুম কোডটি লিখে কোন স্ক্রিন নিয়ন্ত্রণ করবেন তা বেছে নিন।',
      deviceTitle: 'আপনার স্ক্রিন সেটআপ বেছে নিন',
      laptopLaptop: 'ল্যাপটপ ↔ ল্যাপটপ',
      laptopLaptopBody: 'দুই কম্পিউটারেই এক্সটেনশন বসালে প্লে, পজ ও সিক নিজে থেকেই মিলবে।',
      laptopTv: 'ল্যাপটপ ↔ টিভি',
      laptopTvBody: 'সবচেয়ে সহজ বড় পর্দার অভিজ্ঞতার জন্য HDMI বা ব্রাউজার ট্যাব কাস্ট করুন।',
      tvTv: 'টিভি ↔ টিভি',
      tvTvBody: 'কাউন্টডাউন, টাইমকোড ও সংশোধনের জন্য টিভি কনসোল বা ডিভাইস হেলপার ব্যবহার করুন।',
      detailsLabel: 'টিভি সেটআপের বিস্তারিত',
      privacyNote: 'ডুয়েট কখনো ভিডিও কপি, রিলে বা পুনঃস্ট্রিম করে না। দুজনেরই নিজেদের দেখার অনুমতি থাকতে হবে।',
      authRequired: 'চালিয়ে যেতে লগ ইন করুন।',
      invalidCode: 'সঠিক রুম কোড লিখুন।',
      creatingRoom: 'রুম তৈরি হচ্ছে…',
      roomError: 'রুম তৈরি করা যায়নি। আবার চেষ্টা করুন।',
      checkingMac: 'এই Mac পরীক্ষা করা হচ্ছে…',
      loginBack: 'হোমে ফিরুন',
      loginHeadline: 'মুভিটা তাহলে <em>হয়েই যাক</em>।',
      loginSubhead: 'যেখান থেকে থেমেছিলাম, সেখান থেকেই—একসঙ্গে।',
      inviteOnly: 'শুধু আমন্ত্রিতদের জন্য',
      welcomeBack: 'আবার স্বাগতম।',
      loginIntro: 'রুম শুরু করতে বা যোগ দিতে লগ ইন করুন।',
      email: 'ইমেইল',
      password: 'পাসওয়ার্ড',
      showPassword: 'পাসওয়ার্ড দেখুন',
      hidePassword: 'পাসওয়ার্ড লুকান',
      loginButton: 'লগ ইন',
      invitedOnly: 'কেবল আমন্ত্রিতরাই এই ডুয়েট ব্যবহার করতে পারবেন।',
      tooManyAttempts: 'অনেকবার চেষ্টা করা হয়েছে। কয়েক মিনিট অপেক্ষা করুন।',
      disabledAccount: 'এই অ্যাকাউন্টটি বন্ধ আছে। মালিককে চালু করতে বলুন।',
      invalidLogin: 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়।',
      loggingIn: 'লগ ইন হচ্ছে…',
    },
  };

  function initialLanguage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'bn') return stored;
    return navigator.language?.toLowerCase().startsWith('bn') ? 'bn' : 'en';
  }

  let language = initialLanguage();

  function t(key) {
    return dictionaries[language]?.[key] || dictionaries.en[key] || key;
  }

  function apply() {
    document.documentElement.lang = language;
    document.documentElement.classList.toggle('lang-bn', language === 'bn');
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((node) => {
      node.innerHTML = t(node.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-lang]').forEach((button) => {
      const selected = button.dataset.lang === language;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    window.dispatchEvent(new CustomEvent('duet:languagechange', { detail: { language } }));
  }

  function setLanguage(next) {
    if (next !== 'en' && next !== 'bn') return;
    language = next;
    localStorage.setItem(STORAGE_KEY, next);
    apply();
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (button) setLanguage(button.dataset.lang);
  });

  window.DuetI18n = {
    apply,
    setLanguage,
    t,
    get language() { return language; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();
