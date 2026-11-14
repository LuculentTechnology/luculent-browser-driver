// Cases for the Pull page context suite. A single example.com load is not a suite (SOP-100).
// expect.action: extract (default) | refuse | maybe-blocked (bot walls are recorded, not failures)
export function casesFor(origin) {
  return [
    // Local fixtures
    { id: 'local-login-password', cat: 'forms-login', kind: 'local', url: origin + '/login',
      expect: { title: /sign in/i, text: /welcome back/i, minText: 20, forbid: /super-secret-pass/ } },
    { id: 'local-iframe', cat: 'iframes', kind: 'local', url: origin + '/iframes',
      expect: { title: /iframe host/i, text: /IFRAME-MAIN-CONTENT|outer article/i, minText: 20 } },
    { id: 'local-shadow', cat: 'shadow-dom', kind: 'local', url: origin + '/shadow',
      expect: { title: /shadow/i, text: /SECRET-SHADOW-CONTENT/i, minText: 20 } },
    { id: 'local-infinite', cat: 'infinite-scroll', kind: 'local', url: origin + '/infinite', scroll: true,
      expect: { title: /feed/i, text: /Post 1/i, minText: 20 } },
    { id: 'local-huge', cat: 'very-large', kind: 'local', url: origin + '/huge',
      expect: { title: /huge article/i, text: /BEGIN-HUGE-MARKER/i, minText: 1000, truncated: true } },
    { id: 'local-pdf', cat: 'pdf', kind: 'local', url: origin + '/doc.pdf',
      expect: { text: /LBD page context fixture PDF/i, minText: 10 } },

    // News (long articles)
    { id: 'news-guardian-ada', cat: 'news-article', kind: 'live',
      url: 'https://www.theguardian.com/science/2026/nov/13/kurt-godel-notebooks-ai-helps-unlock-hidden-discoveries-man-who-transformed-maths',
      expect: { title: /Godel|Gödel|Godel|maths|math|Guardian/i, text: /Godel|Gödel|notebook|mathematic/i, minText: 400 } },
    { id: 'news-bbc-science', cat: 'news-article', kind: 'live',
      url: 'https://www.bbc.com/news/science-environment-56911922',
      expect: { title: /./, text: /science|climate|space|research|BBC/i, minText: 200 } },
    { id: 'news-npr', cat: 'news-article', kind: 'live',
      url: 'https://www.npr.org/2026/11/13/nx-s1-6039312/spacex-nasa-starship-iss-dragon-falcon-musk',
      expect: { title: /SpaceX|Starship|NASA|NPR/i, text: /SpaceX|Starship|NASA|Dragon|Falcon/i, minText: 200 } },
    { id: 'news-hn', cat: 'news-article', kind: 'live',
      url: 'https://news.ycombinator.com/',
      expect: { title: /hacker news/i, text: /points|discuss|new|past/i, minText: 100 } },
    { id: 'news-ars', cat: 'news-article', kind: 'live',
      url: 'https://arstechnica.com/science/2026/11/james-webb-telescope-finds-ice-older-than-the-star-it-orbits/',
      expect: { title: /Webb|telescope|ice|Ars/i, text: /Webb|telescope|ice|star|JWST/i, minText: 200 } },

    // Wikipedia
    { id: 'wikipedia-ada', cat: 'wikipedia', kind: 'live',
      url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
      expect: { title: /Ada Lovelace/i, text: /analytical engine|mathematician|Babbage/i, minText: 800, heading: /Ada Lovelace/i } },
    { id: 'wikipedia-ww2', cat: 'very-large', kind: 'live',
      url: 'https://en.wikipedia.org/wiki/World_War_II',
      expect: { title: /World War II/i, text: /1939|Allies|Axis/i, minText: 2000 } },
    { id: 'wikipedia-cities', cat: 'wikipedia', kind: 'live',
      url: 'https://en.wikipedia.org/wiki/List_of_largest_cities',
      expect: { title: /largest cities/i, text: /Tokyo|population|city/i, minText: 400 } },
    { id: 'wikipedia-es-ada', cat: 'non-english', kind: 'live',
      url: 'https://es.wikipedia.org/wiki/Ada_Lovelace',
      expect: { title: /Ada Lovelace/i, text: /matem[aá]tica|motor anal[ií]tico|Babbage/i, minText: 400 } },
    { id: 'wikipedia-ja-ada', cat: 'non-english', kind: 'live',
      url: 'https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC',
      expect: { title: /日本/i, text: /日本|東京|天皇|列島/i, minText: 400 } },

    // Docs
    { id: 'docs-mdn-fetch', cat: 'docs', kind: 'live',
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
      expect: { title: /Fetch API/i, text: /fetch\(|Request|Response|promise/i, minText: 400, heading: /Fetch API/i } },
    { id: 'docs-mdn-js', cat: 'docs', kind: 'live',
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide',
      expect: { title: /JavaScript/i, text: /JavaScript|function|MDN/i, minText: 400 } },
    { id: 'docs-stripe', cat: 'docs', kind: 'live', action: 'refuse',
      url: 'https://docs.stripe.com/payments',
      expect: { refuse: /Blocked by your Luculent security settings|banking|payment blocklist/i } },
    { id: 'docs-k8s', cat: 'docs', kind: 'live',
      url: 'https://kubernetes.io/docs/concepts/overview/',
      expect: { title: /Kubernetes|Overview/i, text: /cluster|pod|Kubernetes/i, minText: 300 } },
    { id: 'docs-github', cat: 'docs', kind: 'live',
      url: 'https://docs.github.com/en/get-started/start-your-journey/about-github-and-git',
      expect: { title: /GitHub|Git/i, text: /repository|GitHub|git/i, minText: 200 } },
    { id: 'docs-nodejs-fs', cat: 'docs', kind: 'live',
      url: 'https://nodejs.org/docs/latest/api/fs.html',
      expect: { title: /File system|fs|Node/i, text: /readFile|fs\.|filesystem|file/i, minText: 400 } },
    { id: 'docs-react', cat: 'docs', kind: 'live',
      url: 'https://react.dev/learn',
      expect: { title: /React|Quick Start|Learn/i, text: /component|React/i, minText: 300 } },

    // GitHub
    { id: 'github-repo', cat: 'github-repo', kind: 'live',
      url: 'https://github.com/microsoft/playwright-mcp',
      expect: { title: /playwright-mcp/i, text: /Playwright|MCP|microsoft/i, minText: 200 } },
    { id: 'github-issue', cat: 'github-issue', kind: 'live',
      url: 'https://github.com/microsoft/playwright/issues/1',
      expect: { title: /playwright|issue/i, text: /playwright|issue|github/i, minText: 80 } },

    // YouTube
    { id: 'youtube-video', cat: 'youtube', kind: 'live',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      expect: { title: /zoo|Me at the zoo|YouTube/i, text: /zoo|Jawed|YouTube|video/i, minText: 20 } },

    // Ecommerce (bot walls recorded as blocked, not fail)
    { id: 'amazon-product', cat: 'ecommerce', kind: 'live', action: 'maybe-blocked',
      url: 'https://www.amazon.com/dp/B09B8V1LZ3',
      expect: { title: /./, text: /./, minText: 40 } },
    { id: 'apple-iphone', cat: 'ecommerce', kind: 'live',
      url: 'https://www.apple.com/iphone/',
      expect: { title: /iPhone|Apple/i, text: /iPhone|Apple/i, minText: 80 } },

    // Reddit
    { id: 'reddit-thread', cat: 'reddit', kind: 'live', action: 'maybe-blocked',
      url: 'https://old.reddit.com/r/programming/',
      expect: { title: /programming/i, text: /reddit|posted|comments|programming/i, minText: 40 } },

    // SPA dashboards / public pages
    { id: 'linear-docs', cat: 'spa', kind: 'live',
      url: 'https://linear.app/docs',
      expect: { title: /Linear|Docs/i, text: /Linear|issue|docs|workflow/i, minText: 40 } },
    { id: 'notion-help', cat: 'spa', kind: 'live',
      url: 'https://www.notion.so/help',
      expect: { title: /Notion|Help/i, text: /Notion|workspace|page|help/i, minText: 40 } },

    // PDF in Chrome viewer
    { id: 'pdf-w3-dummy', cat: 'pdf', kind: 'live',
      url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
      expect: { text: /Dummy PDF|placeholder|PDF/i, minText: 8 } },

    // Search results
    { id: 'search-wiki', cat: 'search-results', kind: 'live',
      url: 'https://en.wikipedia.org/w/index.php?search=Ada+Lovelace&title=Special:Search',
      expect: { title: /search|Ada Lovelace/i, text: /Lovelace|search|result/i, minText: 80 } },
    { id: 'search-ddg', cat: 'search-results', kind: 'live',
      url: 'https://duckduckgo.com/?q=Ada+Lovelace',
      expect: { title: /Ada Lovelace|DuckDuckGo/i, text: /Lovelace|DuckDuckGo|results/i, minText: 40 } },

    // Very large live
    { id: 'rfc-9110', cat: 'very-large', kind: 'live',
      url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
      expect: { title: /RFC 9110|HTTP/i, text: /HTTP|status code|RFC/i, minText: 2000 } },

    // Stack Overflow
    { id: 'so-regex', cat: 'docs', kind: 'live',
      url: 'https://stackoverflow.com/questions/1732348/regex-match-open-tags-except-xhtml-self-contained-tags',
      expect: { title: /regex|Stack Overflow|HTML/i, text: /regex|HTML|parse|Stack/i, minText: 200 } },


    // Live infinite-scroll / long feeds (scroll, pull, scroll again, re-pull)
    { id: 'feed-devto', cat: 'infinite-scroll', kind: 'live', scroll: true, scrollAgain: true,
      url: 'https://dev.to/',
      expect: { title: /DEV|Community|software/i, text: /DEV|post|article|community/i, minText: 80 } },
    { id: 'feed-unsplash', cat: 'infinite-scroll', kind: 'live', scroll: true, scrollAgain: true,
      url: 'https://unsplash.com/',
      expect: { title: /Unsplash|photo/i, text: /photo|Unsplash|image/i, minText: 40 } },
    { id: 'feed-youtube-search', cat: 'infinite-scroll', kind: 'live', scroll: true, scrollAgain: true, action: 'maybe-blocked',
      url: 'https://www.youtube.com/results?search_query=Ada+Lovelace',
      expect: { title: /Ada Lovelace|YouTube/i, text: /Lovelace|YouTube|video|views/i, minText: 40 } },
    { id: 'feed-medium-tag', cat: 'infinite-scroll', kind: 'live', scroll: true, scrollAgain: true, action: 'maybe-blocked',
      url: 'https://medium.com/tag/javascript',
      expect: { title: /JavaScript|Medium/i, text: /JavaScript|Medium|story|article/i, minText: 40 } },
    { id: 'feed-hn-more', cat: 'infinite-scroll', kind: 'live', scroll: true, moreLink: true,
      url: 'https://news.ycombinator.com/',
      expect: { title: /hacker news/i, text: /points|discuss|new|past/i, minText: 100 } },

    // Typed dummy password on real login pages (never submit on third-party accounts)
    { id: 'login-heroku-demo', cat: 'forms-login', kind: 'live', typePassword: true,
      url: 'https://the-internet.herokuapp.com/login',
      passwordSelector: '#password',
      usernameSelector: '#username',
      usernameValue: 'tester',
      expect: { title: /login|internet/i, text: /login|username|password/i, minText: 10 } },
    { id: 'login-github', cat: 'forms-login', kind: 'live', typePassword: true,
      url: 'https://github.com/login',
      passwordSelector: '#password, input[type=password], input[name=password]',
      usernameSelector: '#login_field, input[name=login], input[type=text]',
      usernameValue: 'lbd-suite-dummy',
      expect: { title: /sign in|github/i, minText: 10 } },
    { id: 'login-google', cat: 'forms-login', kind: 'live', typePassword: true, action: 'maybe-blocked',
      url: 'https://accounts.google.com/ServiceLogin',
      passwordSelector: 'input[type=password], input[name=Passwd]',
      usernameSelector: 'input[type=email], input[name=identifier], #identifierId',
      usernameValue: 'lbd-suite-dummy@example.com',
      expect: { title: /sign in|google|gmail/i, minText: 5 } },

    // Banking / payment (must refuse)
    { id: 'bank-mercury', cat: 'banking-blocked', kind: 'live', action: 'refuse',
      url: 'https://mercury.com/',
      expect: { refuse: /Blocked by your Luculent security settings|banking|payment blocklist/i } },
    { id: 'bank-chase', cat: 'banking-blocked', kind: 'live', action: 'refuse',
      url: 'https://www.chase.com/',
      expect: { refuse: /Blocked by your Luculent security settings|banking|payment blocklist/i } },
    { id: 'bank-stripe', cat: 'banking-blocked', kind: 'live', action: 'refuse',
      url: 'https://stripe.com/',
      expect: { refuse: /Blocked by your Luculent security settings|banking|payment blocklist/i } },

    // chrome:// and Web Store (must refuse)
    { id: 'chrome-internal', cat: 'chrome-internal', kind: 'local', action: 'refuse',
      url: 'chrome://version/',
      expect: { refuse: /Blocked by your Luculent security settings|browser-internal|internal/i } },
    { id: 'chrome-webstore', cat: 'webstore', kind: 'live', action: 'refuse',
      url: 'https://chromewebstore.google.com/',
      expect: { refuse: /Blocked by your Luculent security settings|Chrome Web Store/i } },
    { id: 'chrome-webstore-legacy', cat: 'webstore', kind: 'live', action: 'refuse',
      url: 'https://chrome.google.com/webstore',
      expect: { refuse: /Blocked by your Luculent security settings|Chrome Web Store/i } },
  ];
}

export const PANEL_SITES = ['wikipedia-ada', 'docs-mdn-fetch', 'local-login-password', 'github-repo'];
export const LLM_SITES = ['wikipedia-ada', 'docs-mdn-fetch', 'news-hn', 'youtube-video', 'github-repo'];
export const DUMMY_PASSWORD = 'LbdDummyPass_t1272_X9!';
