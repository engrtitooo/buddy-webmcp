import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  ArrowDown,
  ArrowRight,
  Ban,
  Braces,
  Check,
  CheckCircle2,
  CircleAlert,
  EyeOff,
  Hand,
  MessageCircle,
  Mic2,
  PauseCircle,
  Radio,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import { products } from './products';
import { applyFilters, market, visibleProducts } from './store';

const demoPrompt =
  "Find me a gift under $50 that arrives before Thursday. Compare the best options, but don't buy anything without asking me.";

const githubBase = 'https://github.com/engrtitooo/buddy-webmcp';

const capabilityLabels = ['Search', 'Details', 'Filter', 'Compare', 'Cart', 'Delivery', 'Checkout'];

const judgeDemoSteps = [
  {
    title: 'Open Buddy Market',
    body: "Buddy automatically detects the site's WebMCP capabilities.",
  },
  {
    title: 'Ask Buddy',
    body: 'Give Buddy the goal below through text or voice.',
  },
  {
    title: 'Watch structured actions',
    body: 'Buddy searches, filters, compares, and updates the market through WebMCP tools.',
  },
  {
    title: 'See the safety boundary',
    body: 'Buddy pauses and requests approval before a consequential action.',
  },
  {
    title: 'Approve or cancel',
    body: 'Cancel proves nothing executes without permission. Approve once to continue.',
  },
];

function BuddyMark({ asleep = false }: { asleep?: boolean }) {
  return (
    <span className={`brand-mark${asleep ? ' asleep' : ''}`} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

export function App({ webmcpSupported }: { webmcpSupported: boolean }) {
  const state = useSyncExternalStore(market.subscribe, market.get);
  const [cartOpen, setCartOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visible = visibleProducts();
  const compared = useMemo(
    () =>
      state.comparedIds.map((id) => products.find((product) => product.id === id)).filter(Boolean),
    [state.comparedIds],
  );
  const cartRows = Object.entries(state.cart).map(([id, quantity]) => ({
    item: products.find((product) => product.id === id)!,
    quantity,
  }));
  const cartCount = Object.values(state.cart).reduce((sum, quantity) => sum + quantity, 0);
  const total = cartRows.reduce((sum, row) => sum + row.item.price * row.quantity, 0);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    applyFilters(query, {});
    market.set({ lastAction: `Showing results for “${query}”` });
  };
  return (
    <div className="market-app">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Buddy home">
          <BuddyMark />
          <span>
            Buddy<small>WEBMCP COMPANION</small>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how-buddy-works">How it works</a>
          <a href="#why-buddy">Why Buddy</a>
          <a href="#safety">Safety</a>
          <a href="#playground">Playground</a>
        </nav>
        <button
          className="cart-button"
          type="button"
          onClick={() => setCartOpen(true)}
          aria-label={`Open demo cart, ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
        >
          <ShoppingBag />
          <span>Demo cart</span>
          <b>{cartCount}</b>
        </button>
      </header>

      <main id="main-content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <span className="overline">BUDDY · WEBMCP COMPANION</span>
            <h1 id="hero-title">
              The friendly interface for the <em>agentic web.</em>
            </h1>
            <p className="hero-lead">
              Buddy is a universal Chrome companion for WebMCP-enabled websites. It discovers what
              each site can do, turns text or voice goals into structured actions, and asks before
              anything consequential.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#judge-demo">
                Try the 60-second demo <ArrowRight />
              </a>
              <a className="button secondary" href="#how-buddy-works">
                See how Buddy uses WebMCP <ArrowDown />
              </a>
            </div>
            <p className="product-line">
              WebMCP gives websites capabilities.{' '}
              <strong>Buddy gives those capabilities a face, a voice, and your rules.</strong>
            </p>
            <p className="hero-context">
              <strong>Buddy is the Chrome companion.</strong> Buddy Market is only the safe WebMCP
              playground used to demonstrate it.
            </p>
            <span className="playground-label">Simulated marketplace · No real purchases</span>
          </div>

          <div className="companion-story" aria-label="How Buddy responds across the web">
            <div className="story-browser">
              <div className="browser-bar">
                <span />
                <span />
                <span />
                <small>the web</small>
              </div>
              <div className="buddy-stage">
                <div className="buddy-halo" />
                <div className="hero-buddy">
                  <BuddyMark />
                </div>
                <span>ONE COMPANION</span>
                <strong>Present only when useful.</strong>
              </div>
            </div>
            <ol className="lifecycle-list">
              <li>
                <span>
                  <EyeOff />
                </span>
                <div>
                  <small>ORDINARY WEBSITE</small>
                  <strong>Buddy stays invisible</strong>
                </div>
              </li>
              <li className="active">
                <span>
                  <Radio />
                </span>
                <div>
                  <small>WEBMCP DETECTED</small>
                  <strong>Buddy wakes up</strong>
                </div>
              </li>
              <li>
                <span>
                  <MessageCircle />
                </span>
                <div>
                  <small>NATURAL GOAL</small>
                  <strong>Buddy understands</strong>
                </div>
              </li>
              <li>
                <span>
                  <Braces />
                </span>
                <div>
                  <small>STRUCTURED ACTIONS</small>
                  <strong>Buddy acts</strong>
                </div>
              </li>
              <li>
                <span>
                  <Hand />
                </span>
                <div>
                  <small>SENSITIVE ACTION</small>
                  <strong>Buddy asks first</strong>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section
          className="problem-section section-shell"
          id="why-buddy"
          aria-labelledby="problem-title"
        >
          <div className="problem-heading">
            <span className="overline">WHY BUDDY EXISTS</span>
            <h2 id="problem-title">
              Agents can use WebMCP. People shouldn&apos;t need to understand WebMCP.
            </h2>
          </div>
          <div className="contrast-grid">
            <article className="without-buddy">
              <span className="contrast-label">
                <X /> Without Buddy
              </span>
              <ul>
                <li>Raw tools and schemas</li>
                <li>Different interfaces on every website</li>
                <li>Unclear agent actions</li>
                <li>Too much technical detail for users</li>
              </ul>
            </article>
            <article className="with-buddy">
              <span className="contrast-label">
                <Check /> With Buddy
              </span>
              <ul>
                <li>One consistent companion</li>
                <li>Natural text or voice goals</li>
                <li>Human-readable capabilities</li>
                <li>Visible activity and personal approval rules</li>
              </ul>
            </article>
          </div>
          <p className="impact-line">
            Buddy makes the agentic web usable by everyday people, not just developers.
          </p>
        </section>

        <section
          className="how-section section-shell"
          id="how-buddy-works"
          aria-labelledby="how-title"
        >
          <div className="section-intro">
            <span className="overline">A COMPANION, NOT A CHATBOT FOR ONE STORE</span>
            <h2 id="how-title">How Buddy works</h2>
            <p>From hidden to helpful in four understandable steps.</p>
          </div>
          <div className="step-grid">
            <article>
              <span className="step-number">01</span>
              <EyeOff />
              <h3>Discover</h3>
              <p>
                Buddy stays out of the way on ordinary websites and wakes up when WebMCP
                capabilities are available.
              </p>
            </article>
            <article>
              <span className="step-number">02</span>
              <Sparkles />
              <h3>Understand</h3>
              <p>
                It translates raw WebMCP tools and schemas into capabilities people can understand.
              </p>
            </article>
            <article>
              <span className="step-number">03</span>
              <Mic2 />
              <h3>Ask naturally</h3>
              <p>
                Tell Buddy the outcome you want through text or voice instead of choosing individual
                functions.
              </p>
            </article>
            <article>
              <span className="step-number">04</span>
              <ShieldCheck />
              <h3>Stay in control</h3>
              <p>
                Buddy performs safe work and pauses before consequential actions according to
                deterministic approval rules.
              </p>
            </article>
          </div>
          <div className="prompt-strip">
            <span>TRY SAYING</span>
            <q>{demoPrompt}</q>
          </div>
        </section>

        <section className="layer-section" id="human-interface-layer" aria-labelledby="why-title">
          <div className="layer-copy">
            <span className="overline">WHY BUDDY?</span>
            <h2 id="why-title">
              WebMCP is the capability layer. Buddy is the human interface layer.
            </h2>
            <p>
              WebMCP gives websites structured, intentional actions that agents can discover and
              invoke. Buddy turns those contracts into a portable consumer experience with natural
              goals, understandable capabilities, visible execution, personal approval rules, and
              one consistent interface across compatible sites.
            </p>
          </div>
          <div className="interface-stack" aria-label="Human to website interface layers">
            <div className="stack-node compact">Human</div>
            <ArrowDown />
            <div className="stack-node buddy-layer">
              <BuddyMark />
              <strong>Buddy</strong>
              <div>
                <span>Voice</span>
                <span>Chat</span>
                <span>Preferences</span>
                <span>Approvals</span>
                <span>Activity</span>
              </div>
            </div>
            <ArrowDown />
            <div className="stack-node protocol">WebMCP</div>
            <ArrowDown />
            <div className="stack-node compact">Website</div>
          </div>
        </section>

        <section className="ecosystem section-shell" aria-labelledby="ecosystem-title">
          <div className="section-intro">
            <span className="overline">VISION · FUTURE WEBMCP ECOSYSTEM</span>
            <h2 id="ecosystem-title">One companion, many WebMCP sites</h2>
            <p>
              Today Buddy Market provides a controlled environment to demonstrate the architecture.
              The same companion model can work across websites that intentionally expose compatible
              WebMCP tools.
            </p>
          </div>
          <div className="ecosystem-map">
            <div className="ecosystem-today">
              <small>TODAY</small>
              <strong>Buddy Market</strong>
              <span>Controlled playground</span>
            </div>
            <ArrowRight className="map-arrow" />
            <div className="ecosystem-buddy">
              <BuddyMark />
              <strong>Same Buddy interface</strong>
              <span>WebMCP underneath</span>
            </div>
            <ArrowRight className="map-arrow" />
            <div className="future-sites">
              <small>FUTURE CATEGORIES</small>
              <div>
                {[
                  'Shopping',
                  'Travel',
                  'Airlines',
                  'Productivity',
                  'Financial services',
                  'Government services',
                ].map((site) => (
                  <span key={site}>{site}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="safety-section" id="safety" aria-labelledby="safety-title">
          <div className="safety-inner">
            <div className="safety-heading">
              <span className="overline">DETERMINISTIC PERMISSION LAYER</span>
              <h2 id="safety-title">AI can plan. Your rules decide what executes.</h2>
              <p>
                The language model proposes actions. It does not control Buddy’s permission rules.
                Every proposed action is evaluated independently before execution.
              </p>
            </div>
            <div className="decision-grid">
              <article className="allow">
                <CheckCircle2 />
                <span>ALLOW</span>
                <strong>Safe action executes.</strong>
              </article>
              <article className="ask">
                <PauseCircle />
                <span>ASK</span>
                <strong>Buddy pauses and shows a clear approval card.</strong>
              </article>
              <article className="block">
                <Ban />
                <span>BLOCK</span>
                <strong>The action does not execute.</strong>
              </article>
            </div>
          </div>
        </section>

        <section className="judge-demo" id="judge-demo" aria-labelledby="judge-demo-title">
          <div className="judge-demo-inner">
            <div className="judge-demo-copy">
              <span className="overline">LIVE PROOF IN FIVE STEPS</span>
              <h2 id="judge-demo-title">60-second judge demo</h2>
              <p>
                One prompt shows discovery, structured execution, and Buddy&apos;s safety boundary.
              </p>
              <div className="demo-identity" aria-label="Product and demo distinction">
                <p>
                  <strong>Buddy</strong>
                  <span>The Chrome companion</span>
                </p>
                <p>
                  <strong>Buddy Market</strong>
                  <span>The controlled WebMCP demo</span>
                </p>
              </div>
              <div className="judge-prompt">
                <span>ASK BUDDY</span>
                <q>{demoPrompt}</q>
                <small>Use text or press Buddy&apos;s voice button.</small>
              </div>
              <p className="demo-safety-note">
                <ShieldCheck /> No real purchases or payments occur.
              </p>
            </div>
            <ol className="judge-steps">
              {judgeDemoSteps.map((step, index) => (
                <li key={step.title}>
                  <span>{index + 1}</span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="playground-intro" id="playground" aria-labelledby="playground-title">
          <div className="playground-heading">
            <span className="overline">BUDDY MARKET · CONTROLLED DEMO</span>
            <h2 id="playground-title">Buddy Market: the controlled WebMCP demo</h2>
            <p>
              Buddy is the portable Chrome companion. This simulated marketplace is the safe
              environment for demonstrating its discovery, execution, comparison, cart, and approval
              experience.
            </p>
          </div>
          <div className="playground-panels">
            <article className="demo-scope-card">
              <div className="mini-buddy">
                <span className="mini-face">
                  <i />
                  <i />
                </span>
              </div>
              <span className="overline">PRODUCT VS. PLAYGROUND</span>
              <h3>Buddy travels with you.</h3>
              <p>
                Buddy Market stays here as a controlled site that intentionally exposes safe demo
                capabilities.
              </p>
              <small>No real purchases or payments occur.</small>
            </article>
            <div
              className={`webmcp-status ${webmcpSupported ? 'ready' : 'needs-flag'}`}
              role="status"
            >
              {webmcpSupported ? <Check /> : <CircleAlert />}
              <div className="status-copy">
                <strong className="status-title">
                  {webmcpSupported ? 'WebMCP detected' : "WebMCP isn't enabled in this browser"}
                </strong>
                <span className="status-detail">
                  {webmcpSupported
                    ? 'Buddy can discover and use this site’s intentionally exposed capabilities.'
                    : 'Enable WebMCP in a supported Chrome build to let Buddy discover these tools.'}
                </span>
                <div className="capability-summary">
                  <b>10 live WebMCP tools</b>
                  <div className="capability-chips" aria-label="WebMCP capabilities">
                    {capabilityLabels.map((label) => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                </div>
                <p className="webmcp-difference">
                  <Braces /> Structured WebMCP actions — not DOM scraping or selector automation.
                </p>
                <small>
                  Buddy executes only capabilities intentionally exposed by the website.
                </small>
              </div>
            </div>
          </div>
          <form className="market-search" onSubmit={submit}>
            <Search />
            <label className="sr-only" htmlFor="market-query">
              Search Buddy Market products
            </label>
            <input
              id="market-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Or browse the playground yourself"
            />
            <button type="submit">Search market</button>
          </form>
          <div className="popular">
            <span>Quick filters:</span>
            {['a gift under $50', 'headphones', 'something for home'].map((value) => (
              <button
                type="button"
                key={value}
                onClick={() => {
                  setQuery(value);
                  applyFilters(value, {});
                }}
              >
                {value}
              </button>
            ))}
          </div>
        </section>

        <section className="catalog" id="catalog" aria-labelledby="catalog-title">
          <div className="section-head">
            <div>
              <span className="overline">INTERACTIVE WEBMCP CATALOG</span>
              <h2 id="catalog-title">
                {state.query
                  ? `Results for “${state.query}”`
                  : 'Products Buddy can search, filter, and compare.'}
              </h2>
              <p>
                {visible.length} items · {state.lastAction}
              </p>
            </div>
            <button
              className="reset"
              type="button"
              onClick={() => {
                market.reset();
                setQuery('');
              }}
            >
              <RotateCcw />
              Reset demo
            </button>
          </div>
          {compared.length > 0 && (
            <section className="compare" aria-label="Compared products">
              <div className="compare-title">
                <div>
                  <span className="overline">BUDDY COMPARED</span>
                  <h3>The strongest options, side by side</h3>
                </div>
                <button
                  type="button"
                  onClick={() => market.set({ comparedIds: [] })}
                  aria-label="Close comparison"
                >
                  <X />
                </button>
              </div>
              <div className="compare-grid">
                {compared.map((item, index) => (
                  <article key={item!.id}>
                    <span className="rank">
                      {index === 0 ? 'BEST MATCH' : `OPTION ${index + 1}`}
                    </span>
                    <strong>{item!.name}</strong>
                    <b>${item!.price}</b>
                    <small>
                      <Star /> {item!.rating} · {item!.deliveryDay}
                    </small>
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className="product-grid">
            {visible.map((product) => (
              <article
                className={`product-card ${state.comparedIds.includes(product.id) ? 'selected' : ''}`}
                key={product.id}
              >
                <div
                  className="product-art"
                  style={{ '--tone': product.tone } as React.CSSProperties}
                >
                  <span>{product.category}</span>
                  <i />
                  <i />
                </div>
                <div className="product-info">
                  <div className="product-meta">
                    <span>{product.category}</span>
                    <span>
                      <Star /> {product.rating}
                    </span>
                  </div>
                  <h3>{product.name}</h3>
                  <p>{product.description}</p>
                  <div className="attributes">
                    {product.attributes.map((attribute) => (
                      <span key={attribute}>{attribute}</span>
                    ))}
                  </div>
                  <div className="product-bottom">
                    <div>
                      <strong>${product.price}</strong>
                      <small>Arrives {product.deliveryDay}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        market.set({
                          cart: { ...state.cart, [product.id]: (state.cart[product.id] ?? 0) + 1 },
                          lastAction: `Added ${product.name} manually`,
                        });
                        setCartOpen(true);
                      }}
                      aria-label={`Add ${product.name} to cart`}
                    >
                      <ShoppingBag />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {!visible.length && (
            <div className="empty-results">
              <Search />
              <h3>No exact matches</h3>
              <p>Reset the demo or ask Buddy to try a wider search.</p>
            </div>
          )}
        </section>
      </main>

      <footer>
        <div className="footer-brand">
          <div className="brand">
            <BuddyMark />
            <span>
              Buddy<small>THE FRIENDLY INTERFACE FOR THE AGENTIC WEB</small>
            </span>
          </div>
          <p>Buddy Market is the controlled WebMCP demo playground.</p>
        </div>
        <div className="footer-message">
          <p>
            WebMCP gives websites capabilities. Buddy gives those capabilities a face, a voice, and
            your rules.
          </p>
          <nav aria-label="Project links">
            <a href={githubBase}>GitHub</a>
            <a href={`${githubBase}/blob/main/ARCHITECTURE.md`}>Architecture</a>
            <a href={`${githubBase}/blob/main/SECURITY.md`}>Security</a>
          </nav>
        </div>
      </footer>

      {cartOpen && (
        <div
          className="cart-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCartOpen(false);
          }}
        >
          <aside className="cart-drawer" aria-label="Demo cart" aria-modal="true" role="dialog">
            <header>
              <div>
                <span className="overline">DEMO CART</span>
                <h2>Your thoughtful finds</h2>
              </div>
              <button type="button" onClick={() => setCartOpen(false)} aria-label="Close cart">
                <X />
              </button>
            </header>
            <div className="cart-content">
              {cartRows.length === 0 ? (
                <div className="cart-empty">
                  <ShoppingBag />
                  <h3>Your cart is quiet</h3>
                  <p>Ask Buddy to find something, or browse the collection.</p>
                </div>
              ) : (
                cartRows.map(({ item, quantity }) => (
                  <article key={item.id}>
                    <span className="cart-art" style={{ background: item.tone }} />
                    <div>
                      <strong>{item.name}</strong>
                      <span>
                        Qty {quantity} · Arrives {item.deliveryDay}
                      </span>
                    </div>
                    <b>${(item.price * quantity).toFixed(2)}</b>
                  </article>
                ))
              )}
            </div>
            <div className="cart-summary">
              <div>
                <span>Total</span>
                <strong>${total.toFixed(2)}</strong>
              </div>
              <p>
                <ShieldCheck /> Demo only—no payment or real order.
              </p>
              {state.orderComplete ? (
                <div className="order-success">
                  <Check />
                  <strong>Demo order complete</strong>
                  <span>No charge was made.</span>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!cartRows.length}
                  onClick={() =>
                    market.set({ checkoutPrepared: true, lastAction: 'Checkout prepared manually' })
                  }
                >
                  Review demo checkout
                  <ArrowRight />
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
