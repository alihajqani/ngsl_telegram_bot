/**
 * Persian locale — the source of truth for the message catalogue.
 *
 * `en.ts` is typed against this object's shape, so a key added here that is not
 * translated there fails the build. That is deliberate: v1's rule that no
 * user-facing string may be inlined only holds if the type system enforces it.
 */
export const fa = {
  errors: {
    generic: '⚠️ مشکلی پیش آمد. لطفاً دوباره تلاش کنید.',
    session: '⚠️ این پیام قدیمی است. لطفاً دوباره شروع کنید.',
  },

  channel: {
    prompt:
      '👋 برای استفاده از ربات، ابتدا در کانال ما عضو شوید.\n\n' +
      'پس از عضویت، دکمهٔ «بررسی عضویت» را بزنید.',
    joinButton: '📢 عضویت در کانال',
    checkButton: '✅ بررسی عضویت',
    notJoined: '❌ هنوز عضو کانال نشده‌اید.',
    joined: '✅ عضویت تأیید شد. خوش آمدید!',
  },

  start: {
    welcome:
      '📚 <b>سلام {name}!</b>\n\n' +
      'اینجا انگلیسی را با <b>{wordCount}</b> واژهٔ پرکاربرد یاد می‌گیرید — ' +
      'همراه با کلیپ‌های واقعی از سخنرانی‌های TED و BBC.',
    guide:
      '<b>چطور کار می‌کند؟</b>\n\n' +
      '📖 <b>واژه‌های جدید</b> — هر روز چند واژهٔ تازه با مثال و کلیپ\n' +
      '🔄 <b>مرور</b> — سیستم لایتنر واژه‌ها را در زمان درست برمی‌گرداند\n' +
      '🎬 <b>کلیپ</b> — همان واژه در گفتار واقعی، هر بار کلیپ‌های تازه\n' +
      '📊 <b>پیشرفت</b> — ببینید چقدر جلو رفته‌اید\n\n' +
      'از منوی پایین شروع کنید 👇',
  },

  menu: {
    newWords: '📖 واژه‌های جدید',
    review: '🔄 مرور',
    writing: '✍️ تمرین نوشتن',
    streak: '🔥 امتیاز و رشته',
    progress: '📊 پیشرفت',
    settings: '⚙️ تنظیمات',
    prompt: 'یکی از گزینه‌ها را انتخاب کنید:',
  },

  newWords: {
    header: '📖 <b>{count} واژهٔ جدید برای امروز</b>',
    done: '✅ واژه‌های امروز تمام شد. برای تثبیت، بخش مرور را امتحان کنید.',
    limitReached:
      '🎯 سقف امروز شما ({target} واژه) پر شده است.\n' +
      'می‌توانید از تنظیمات آن را تغییر دهید.',
    allSeen: '🎉 تمام واژه‌های فهرست را دیده‌اید! فقط مرور باقی مانده.',
  },

  review: {
    header: '🔄 <b>{count} واژه برای مرور</b>',
    empty: '✅ فعلاً چیزی برای مرور نیست. بعداً برگردید.',
    limitReached: '🎯 سقف مرور امروز ({target} واژه) پر شده است.',
    prompt: 'این واژه را می‌دانید؟',
    correct: '✅ آفرین! <b>{lemma}</b> به جعبهٔ {box} رفت.',
    wrong: '📌 اشکالی ندارد — <b>{lemma}</b> به جعبهٔ ۱ برگشت.',
    known: '⏭️ <b>{lemma}</b> مسلط علامت خورد و به جعبهٔ ۵ رفت.',
    nextDue: 'مرور بعدی: {days} روز دیگر',
    sessionDone: '🎉 <b>مرور امروز تمام شد!</b>\n{count} واژه مرور کردید.',
    buttons: {
      correct: '✅ می‌دانم',
      wrong: '❌ نمی‌دانم',
      known: '⏭️ کاملاً بلدم',
    },
  },

  card: {
    word: '<b>{lemma}</b>',
    definition: '<i>{definition}</i>',
    box: '📦 جعبهٔ {box}',
    reviewCount: '🔄 {count} بار مرور شده',
    remaining: '<i>{count} واژهٔ دیگر باقی مانده</i>',
    firstTime: '🆕 اولین بار',
    buttons: {
      examples: '📝 مثال‌ها',
      collocations: '🔗 ترکیب‌ها',
      clips: '🎬 کلیپ‌ها',
      dictionary: '📕 دیکشنری',
    },
  },

  content: {
    examplesHeader: '📝 <b>مثال برای «{lemma}»</b>',
    collocationsHeader: '🔗 <b>ترکیب‌ها و اصطلاح‌های «{lemma}»</b>',
    noExamples: 'برای این واژه هنوز مثالی ثبت نشده است.',
    noCollocations: 'برای این واژه هنوز ترکیبی ثبت نشده است.',
    watchButton: '🎬 دیدن در ویدیو',
    idiomTag: '💬',
  },

  clips: {
    header: '🎬 <b>«{lemma}» در گفتار واقعی</b>',
    caption: '💬 {sentence}',
    preparing:
      '⏳ کلیپ‌های این واژه در حال آماده‌سازی است.\n' +
      'چند دقیقهٔ دیگر دوباره امتحان کنید.',
    none: 'برای این واژه کلیپی پیدا نشد.',
    exhausted: 'ℹ️ همهٔ کلیپ‌های تازه را دیده‌اید — این‌ها تکراری هستند.',
  },

  writing: {
    prompt:
      '✍️ <b>تمرین نوشتن</b>\n\n' +
      'متنی بنویسید که در آن از این واژه‌ها استفاده کنید:\n{words}\n\n' +
      '<i>بین {min} تا {max} کلمه بنویسید و همین‌جا بفرستید.</i>',
    memoryHeader: '🧠 <b>یادآوری از جلسه‌های قبل</b>',
    notEnoughWords:
      '📚 هنوز واژهٔ کافی برای تمرین نوشتن ندارید.\n' +
      'کمی بیشتر مرور کنید تا واژه‌ها به جعبه‌های بالاتر برسند.',
    tooShort: '✏️ متن شما {words} کلمه است. حداقل {min} کلمه بنویسید.',
    tooLong: '✏️ متن شما {words} کلمه است. حداکثر {max} کلمه مجاز است.',
    grading: '⏳ در حال بررسی متن شما...',
    llmUnavailable: '⚠️ دستیار هوشمند در دسترس نیست. کمی بعد دوباره تلاش کنید.',
    feedbackHeader: '📝 <b>بازخورد</b> — {score}/10 {stars}',
    used: '✅ واژه‌های استفاده‌شده: {words}',
    missed: '⬜ استفاده‌نشده: {words}',
    issuesHeader: '<b>نکته‌های گرامری</b>',
    suggestionsHeader: '<b>پیشنهادها</b>',
    correctedHeader: '✏️ <b>متن اصلاح‌شده</b>',
    sampleHeader: '🎓 <b>نمونهٔ یک نویسندهٔ بومی</b>',
    sampleNote: 'این متن مستقل نوشته شده و متن شما را ندیده است — سبک‌ها را مقایسه کنید.',
    cancelButton: '❌ انصراف',
    cancelled: 'تمرین نوشتن لغو شد.',
  },

  game: {
    streakHeader: '🔥 <b>وضعیت شما</b>',
    streakLine: '{flame} رشتهٔ فعلی: <b>{current}</b> روز  (رکورد: {longest})',
    multiplierLine: '⚡ ضریب امتیاز: <b>×{multiplier}</b>',
    freezeLine: '🧊 سپر یخی: <b>{freezes}</b>',
    pointsLine: '⭐ امتیاز کل: <b>{points}</b>',
    atRisk: '⚠️ امروز هنوز مطالعه نکرده‌اید — رشته‌تان در خطر است!',
    buddyLine: '🤝 رشتهٔ مشترک با همراه: <b>{streak}</b> روز',
    leagueButton: '🏆 لیگ هفته',
    globalButton: '🌍 برترین‌ها',
    buddyButton: '🤝 همراه',
    leagueHeader: '🏆 <b>لیگ {tier}</b> — این هفته',
    leagueFooter: '<i>🔼 پنج نفر اول صعود، 🔽 پنج نفر آخر سقوط می‌کنند.</i>',
    noLeague: 'هنوز وارد لیگی نشده‌اید. یک درس شروع کنید تا اضافه شوید.',
    globalHeader: '🌍 <b>برترین‌های همیشگی</b>',
    yourRank: 'رتبهٔ شما: <b>{rank}</b> با {points} امتیاز',
    tiers: {
      bronze: 'برنز',
      silver: 'نقره',
      gold: 'طلا',
      sapphire: 'یاقوت',
      diamond: 'الماس',
    },
    buddyInvite:
      '🤝 <b>همراه مطالعه</b>\n\n' +
      'این لینک را برای یک دوست بفرستید. رشتهٔ مشترک شما فقط وقتی جلو می‌رود که ' +
      '<b>هر دو</b> در آن روز مطالعه کنید.\n\n{link}',
    buddyActive: '🤝 شما همراه دارید — رشتهٔ مشترک: <b>{streak}</b> روز',
    buddyPaired: '🎉 همراه شما ثبت شد! از امروز رشتهٔ مشترک‌تان شروع می‌شود.',
    buddyTaken: 'یکی از شما از قبل همراه دارد.',
    buddySelf: 'نمی‌توانید همراه خودتان باشید 🙂',
    lazyHeader: '😴 <b>تابلوی تنبل‌ها</b>',
    lazyEmpty: 'هیچ‌کس اینجا نیست — همه فعال‌اند! 🎉',
    lazyDays: '{days} روز غیبت',
    lazyRedemption: '<i>یک جلسهٔ مطالعه کافی است تا از این تابلو خارج شوید.</i>',
    lazyOptIn: '✅ عضو شدن',
    lazyOptOut: '❌ خارج شدن',
    lazyJoined: 'به تابلوی تنبل‌ها اضافه شدید (اختیاری).',
    lazyLeft: 'از تابلوی تنبل‌ها خارج شدید.',
    earned: '⭐ +{points} امتیاز',
    milestone: '🎉 <b>{days} روز پیاپی!</b> +{bonus} امتیاز پاداش',
    freezeUsed: '🧊 یک سپر یخی مصرف شد — رشتهٔ شما حفظ شد!',
  },

  settings: {
    header: '⚙️ <b>تنظیمات</b>',
    newTarget: '📖 واژهٔ جدید در روز: <b>{value}</b>',
    reviewTarget: '🔄 مرور در روز: <b>{value}</b>',
    hint: '<i>برای تغییر، روی عددها بزنید.</i>',
    newLabel: '— واژهٔ جدید در روز —',
    reviewLabel: '— مرور در روز —',
    dictionary: '📕 دیکشنری: {value}',
    dict: { cambridge: 'کمبریج', oxford: 'آکسفورد' },
    remindersOn: '🔔 یادآوری: روشن',
    remindersOff: '🔕 یادآوری: خاموش',
    motivationOn: '🌅 انگیزهٔ روزانه: روشن',
    motivationOff: '🌅 انگیزهٔ روزانه: خاموش',
    shameOn: '😴 تابلوی تنبل‌ها: عضو',
    shameOff: '😴 تابلوی تنبل‌ها: غیرعضو',
    language: '🌐 زبان: {value}',
    languageChanged: '✅ زبان تغییر کرد.',
    saved: 'ذخیره شد',
  },

  progress: {
    header: '📊 <b>پیشرفت شما</b>',
    body:
      '{bar}  {percent}%\n\n' +
      '📚 واژه‌های یادگرفته: <b>{learned}</b>\n' +
      '🎯 تسلط: <b>{mastery}%</b>\n' +
      '🔁 نیازمند مرور: <b>{refresh}</b>\n\n' +
      '<i>از مجموع {total} واژهٔ فهرست</i>',
  },
};

/**
 * Deliberately NOT `as const`: literal types would force every English string to
 * equal its Persian counterpart. Structural typing still guarantees that every
 * key exists in both catalogues, which is the property we actually want.
 */
export type Locale = typeof fa;
