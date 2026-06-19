import { useState, useRef, useMemo, useEffect, memo } from 'react'
import './App.css'

function formatDate(dateStr) {
  if (!dateStr) return 'No date found'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return 'No date found'
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

// Real Twitter hides the leading @mentions of a reply from the body and shows
// them in the "Replying to" line instead.
function stripLeadingMentions(text) {
  return (text || '').replace(/^(?:@\w{1,15}\s+)+/, '').trim()
}

// Matches either a URL or an @mention (Twitter handles are 1-15 word chars).
const TOKEN_RE = /(https?:\/\/[^\s]+|@\w{1,15})/g

// When a tweet has media, Twitter drops the trailing t.co self-link (it just
// points back at the tweet's own media), so we do the same to avoid a dangling
// link under the rendered video/photo.
function stripTrailingTco(text) {
  return (text || '').replace(/\s*https?:\/\/t\.co\/\w+\s*$/, '').trim()
}

// Split text into URLs, @mentions, and plain text. URLs become clickable links;
// @mentions get the accent color (in any tweet, reply or not), matching Twitter.
function renderTextWithLinks(text) {
  const parts = (text || '').split(TOKEN_RE)
  return parts.map((part, i) => {
    if (!part) return null
    if (/^https?:\/\//.test(part)) {
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    }
    if (/^@\w{1,15}$/.test(part)) {
      return <span key={i} className="xt-mention">{part}</span>
    }
    return part
  })
}

// Default avatar placeholder (used when the archive yields no profile image)
function DefaultAvatar({ className }) {
  return (
    <div className={className}>
      <svg viewBox="0 0 24 24" width="58%" height="58%" fill="#ffffff" aria-hidden="true">
        <path d="M12 11.8a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0 1.8c-3.5 0-9 1.8-9 5.2v1.8h18v-1.8c0-3.4-5.5-5.2-9-5.2Z" />
      </svg>
    </div>
  )
}

// Stable identity for a tweet, used both for dedup and as the React key. Using
// content (not array index) keeps keys stable across re-sorts, so React moves
// existing rows instead of remounting them — which is what kills the jank.
function tweetKey(t) {
  return `${t.timestamp}|${t.text}`
}

// Renders a single media item. The archive yields photos, videos, GIFs, and
// external link cards; video whose stream Wayback never captured falls back to
// its poster as a thumbnail linking to the archived tweet.
function TweetMedia({ media }) {
  // Tolerate the legacy shape (a bare image URL string) still in server cache.
  const m = typeof media === 'string' ? { type: 'photo', src: media } : media

  if (m.type === 'gif') {
    return m.src ? (
      <video className="xt-media-video" src={m.src} poster={m.poster || undefined}
        autoPlay loop muted playsInline controls={false} />
    ) : (
      <a className="xt-media-link" href={m.href} target="_blank" rel="noopener noreferrer">
        <img src={m.poster} alt="" loading="lazy" />
        <span className="xt-media-badge">GIF</span>
      </a>
    )
  }

  if (m.type === 'video') {
    return m.src ? (
      <video className="xt-media-video" src={m.src} poster={m.poster || undefined} controls playsInline />
    ) : (
      <a className="xt-media-link" href={m.href} target="_blank" rel="noopener noreferrer">
        <img src={m.poster} alt="" loading="lazy" />
        <span className="xt-media-badge xt-media-badge--play">▶</span>
      </a>
    )
  }

  if (m.type === 'card') {
    return (
      <a className="xt-card" href={m.href || undefined} target="_blank" rel="noopener noreferrer">
        {m.image && <img className="xt-card-img" src={m.image} alt="" loading="lazy" />}
        <div className="xt-card-body">
          {m.title && <div className="xt-card-title">{m.title}</div>}
          {m.description && <div className="xt-card-desc">{m.description}</div>}
          {m.href && <div className="xt-card-host">{(() => { try { return new URL(m.href).hostname.replace(/^www\./, '') } catch { return m.href } })()}</div>}
        </div>
      </a>
    )
  }

  return <img src={m.src} alt="" loading="lazy" />
}

// Memoized row so already-rendered tweets don't re-render as new ones stream in.
const TweetRow = memo(function TweetRow({ tweet, displayName, handle, profileAvatarUrl }) {
  // Always use the one canonical account avatar (resolved once per profile load)
  // rather than a per-tweet avatar — on reply permalinks the per-tweet scrape can
  // pick up the replied-to user's pfp instead of the account's.
  const avatarUrl = profileAvatarUrl
  return (
    <li className="xt-tweet">
      <div className="xt-tweet-avatar">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" loading="lazy" />
        ) : (
          <DefaultAvatar className="xt-avatar-placeholder" />
        )}
      </div>
      <div className="xt-tweet-main">
        <div className="xt-tweet-head">
          <span className="xt-tweet-name">{displayName}</span>
          <span className="xt-tweet-handle">@{handle}</span>
          <span className="xt-dot">·</span>
          <span className="xt-tweet-time">{formatDate(tweet.timestamp)}</span>
        </div>
        {tweet.isReply && (
          <div className="xt-replying">
            Replying to <span>{tweet.replyingTo ? tweet.replyingTo : 'this thread'}</span>
          </div>
        )}
        <div className="xt-tweet-text">
          {(() => {
            const hasMedia = tweet.media && tweet.media.length > 0
            let body = tweet.isReply ? (stripLeadingMentions(tweet.text) || tweet.text) : tweet.text
            if (hasMedia) body = stripTrailingTco(body) || body
            return renderTextWithLinks(body)
          })()}
        </div>
        {tweet.media && tweet.media.length > 0 && (
          <div className="xt-media">
            {tweet.media.map((m, idx) => (
              <TweetMedia key={idx} media={m} />
            ))}
          </div>
        )}
      </div>
    </li>
  )
})

// Placeholder row shown while tweets are still streaming in, so the timeline
// visibly fills rather than waiting behind a single spinner.
const TweetSkeleton = memo(function TweetSkeleton() {
  return (
    <li className="xt-tweet" aria-hidden="true">
      <div className="xt-tweet-avatar xt-skeleton-avatar" />
      <div className="xt-tweet-main">
        <div className="xt-skeleton-line xt-skeleton-line--head" />
        <div className="xt-skeleton-line" />
        <div className="xt-skeleton-line xt-skeleton-line--short" />
      </div>
    </li>
  )
})

// Sort newest-first by tweet creation time. Applied once per page (on finish),
// not on every flush, so rows don't jump while a page is still streaming in.
function sortByNewest(list) {
  return [...list].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
}

function App() {
  const [username, setUsername] = useState('')
  // The username of the profile currently loaded/displayed. Only updates on
  // submit, so typing a new query doesn't mutate the already-loaded profile.
  const [loadedUsername, setLoadedUsername] = useState('')
  const [tweets, setTweets] = useState([])
  const [profile, setProfile] = useState(null)
  const [activeTab, setActiveTab] = useState('posts')
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  // Highest page index loaded so far; the next infinite-scroll fetch is page+1.
  const [page, setPage] = useState(0)
  // Whether the bottom-of-list sentinel is in view (driven solely by the observer).
  const [atListEnd, setAtListEnd] = useState(false)
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const eventSourceRef = useRef(null)
  const sentinelRef = useRef(null)
  // Incoming tweets are buffered and flushed in chunks (rather than one state
  // update per tweet) so the timeline grows smoothly instead of thrashing.
  const tweetBufferRef = useRef([])
  const flushTimerRef = useRef(null)
  // Tracks the username of the active search so a slow profile response for a
  // previous search can be discarded instead of overwriting the current one.
  const profileReqRef = useRef('')

  const cleanUsername = username.replace(/^@/, '')
  const displayName = profile?.displayName || loadedUsername || 'Unknown'
  const isLoading = streaming || loadingMore

  // How many skeleton rows to show at the bottom of the timeline while a page
  // streams. Before `meta` arrives (CDX phase) the count is unknown, so show a
  // small fixed run; afterwards track the unprocessed remainder, capped.
  const SKELETON_CAP = 8
  const skeletonCount = !isLoading
    ? 0
    : progress.total === 0
      ? 6
      : Math.max(0, Math.min(SKELETON_CAP, progress.total - progress.loaded))

  const posts = useMemo(() => tweets.filter(t => !t.isReply), [tweets])
  const replies = useMemo(() => tweets.filter(t => t.isReply), [tweets])
  const shown = activeTab === 'posts' ? posts : replies

  // Flush all buffered tweets into the timeline in one batched update.
  const flushTweetBuffer = () => {
    flushTimerRef.current = null
    const buffered = tweetBufferRef.current
    if (buffered.length === 0) return
    tweetBufferRef.current = []
    setTweets(prev => {
      const seen = new Set(prev.map(tweetKey))
      const additions = []
      for (const t of buffered) {
        const k = tweetKey(t)
        if (!seen.has(k)) {
          seen.add(k)
          additions.push(t)
        }
      }
      if (additions.length === 0) return prev
      // Append in arrival order so already-rendered rows never move mid-stream;
      // the list is snap-sorted newest-first once the page finishes (see finish()).
      return prev.concat(additions)
    })
  }

  const clearTweetBuffer = () => {
    tweetBufferRef.current = []
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }

  // Loads one page of tweets over SSE. `append` distinguishes the initial
  // search (replace the timeline) from infinite-scroll (add to it).
  const loadPage = (user, pageNum, append) => {
    if (!user) return
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    if (append) {
      setLoadingMore(true)
    } else {
      setStreaming(true)
      setLoading(true)
    }
    setProgress({ loaded: 0, total: 0 })

    try {
      const eventSource = new EventSource(`/api/tweets/stream/${user}?page=${pageNum}`)
      eventSourceRef.current = eventSource

      const finish = () => {
        // Flush any tweets still sitting in the buffer when the page completes.
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current)
        }
        flushTweetBuffer()
        // Now the page is done, snap the accumulated list into newest-first order.
        // Doing it here (once per page) rather than on every flush keeps rows from
        // jumping around while tweets are still streaming in out of fetch order.
        setTweets(sortByNewest)
        setStreaming(false)
        setLoading(false)
        setLoadingMore(false)
        eventSource.close()
      }

      eventSource.onmessage = (event) => {
        const { type, data } = JSON.parse(event.data)

        switch (type) {
          case 'meta':
            setHasMore(data.hasMore)
            break
          case 'progress':
            setProgress(data)
            break
          case 'profile':
            // Tweet-derived fallback: fill only fields not already set, so the
            // authoritative /api/profile data (which may arrive before or after)
            // always wins for fields it provides.
            setProfile(prev => {
              const next = { ...prev }
              for (const [k, v] of Object.entries(data)) {
                if (v && !next[k]) next[k] = v
              }
              return next
            })
            break
          case 'tweet':
            // Buffer and flush in ~100ms chunks so the list grows smoothly
            // instead of re-rendering on every single tweet.
            tweetBufferRef.current.push(data)
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(flushTweetBuffer, 100)
            }
            break
          case 'complete':
            setPage(pageNum)
            setHasMore(data.hasMore)
            finish()
            if (!append) {
              setTweets(currentTweets => {
                if (currentTweets.length === 0) setError('No archived tweets found.')
                return currentTweets
              })
            }
            break
          case 'error':
            setError(data.message || 'Failed to fetch tweets.')
            // Drop the sentinel so infinite scroll stops auto-retrying into the
            // same error (which would re-hammer Wayback and prolong a block).
            setHasMore(false)
            finish()
            break
        }
      }

      eventSource.onerror = () => {
        // Only surface a connection error on the initial load; a dropped
        // "load more" shouldn't blow away an already-populated timeline.
        if (!append) setError('Connection lost. Please try again.')
        finish()
      }

    } catch (err) {
      if (!append) setError('Failed to connect to server.')
      setStreaming(false)
      setLoading(false)
      setLoadingMore(false)
    }
  }

  // Fetch the full archived profile (bio, banner, stats, etc.) in parallel with
  // the tweet stream so it never blocks tweets from showing. The archived data
  // is authoritative, so it overwrites any tweet-derived fallback fields.
  const loadProfile = (user) => {
    if (!user) return
    profileReqRef.current = user
    fetch(`/api/profile/${user}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data || profileReqRef.current !== user) return
        setProfile(prev => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(data)) {
            if (v) next[k] = v
          }
          return next
        })
      })
      .catch(() => {})
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    clearTweetBuffer()
    setTweets([])
    setProfile(null)
    setActiveTab('posts')
    setProgress({ loaded: 0, total: 0 })
    setHasMore(false)
    setAtListEnd(false)
    setPage(0)
    setHasSearched(true)
    if (!cleanUsername.trim()) return
    setLoadedUsername(cleanUsername)
    loadPage(cleanUsername, 0, false)
    loadProfile(cleanUsername)
  }

  // The observer's only responsibility: report whether the bottom-of-list
  // sentinel is in view. Re-attaches when the sentinel mounts/unmounts (i.e.
  // when `hasMore` toggles).
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) {
      setAtListEnd(false)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setAtListEnd(entry.isIntersecting),
      { rootMargin: '600px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore])

  // The load decision: fetch the next page whenever we're idle, there's more to
  // fetch, and the sentinel is in view. Because this re-runs when loading
  // finishes (`isLoading` flips), a short page that leaves the sentinel visible
  // keeps filling — no timers or manual measurement needed.
  useEffect(() => {
    if (atListEnd && hasMore && !isLoading && loadedUsername) {
      loadPage(loadedUsername, page + 1, true)
    }
  }, [atListEnd, hasMore, isLoading, loadedUsername, page])

  const handleTitleClick = () => {
    setHasSearched(false)
    setUsername('')
    setLoadedUsername('')
    profileReqRef.current = ''
    clearTweetBuffer()
    setTweets([])
    setProfile(null)
    setActiveTab('posts')
    setError('')
    setProgress({ loaded: 0, total: 0 })
    setHasMore(false)
    setAtListEnd(false)
    setPage(0)
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }
  }

  const profileAvatarUrl = profile?.avatarUrl

  return (
    <div>
      {!hasSearched ? (
        // Title screen - centered layout
        <div className="tw-title-screen">
          <div className="tw-title-container">
            <h1 className="tw-title-large">xTinct</h1>
            <p className="tw-subtitle">ever lost a fan account to twitter suspension? not to worry. this tool brings your account back to life using public data from the <a href="https://wayback.archive.org" target="_blank" rel="noopener noreferrer">Wayback Machine</a>.</p>
            <form onSubmit={handleSubmit} className="tw-search-form-centered">
              <label className="tw-input-label">enter a past or present twitter username...</label>
              <input
                className="tw-input"
                type="text"
                placeholder="@username"
                value={`@${cleanUsername}`}
                onChange={e => setUsername(e.target.value.replace(/^@/, ''))}
                spellCheck="false"
              />
              <button type="submit" className="tw-btn" disabled={loading}>
                {loading ? 'Searching...' : 'Search'}
              </button>
            </form>
            {error && <div className="tw-error">{error}</div>}
          </div>
        </div>
      ) : (
        // Results screen - Twitter-style profile layout
        <div className="xt-app">
          {/* Search bar replaces the Figma status bar */}
          <header className="xt-searchbar">
            <div className="xt-searchbar-inner">
              <div className="xt-brand" onClick={handleTitleClick}>xTinct</div>
              <form onSubmit={handleSubmit} className="xt-search-form">
                <input
                  className="tw-input"
                  type="text"
                  placeholder="@username"
                  value={`@${cleanUsername}`}
                  onChange={e => setUsername(e.target.value.replace(/^@/, ''))}
                  spellCheck="false"
                />
                <button type="submit" className="tw-btn" disabled={loading}>
                  {loading ? 'Searching...' : 'Search'}
                </button>
              </form>
            </div>
          </header>

          <div className="xt-profile">
            {error && <div className="tw-error" style={{ padding: '12px 18px', margin: 0 }}>{error}</div>}

            {/* Banner — archived header image when recovered, else the gradient */}
            {profile?.bannerUrl ? (
              <div className="xt-banner xt-banner--img">
                <img src={profile.bannerUrl} alt="" />
              </div>
            ) : (
              <div className="xt-banner" aria-hidden="true" />
            )}

            {/* Profile header card */}
            <div className="xt-header">
              <div className="xt-avatar-wrap">
                {profile?.avatarUrl ? (
                  <img className="xt-avatar-img" src={profile.avatarUrl} alt={displayName} />
                ) : isLoading && !profile ? (
                  <div className="xt-avatar-img xt-skeleton-avatar" />
                ) : (
                  <DefaultAvatar className="xt-avatar-img xt-avatar-placeholder" />
                )}
              </div>

              <div className="xt-identity">
                {!profile?.displayName && isLoading ? (
                  <div className="xt-display-name xt-skeleton-line xt-skeleton-line--name" />
                ) : (
                  <div className="xt-display-name">{displayName}</div>
                )}
                <div className="xt-handle">@{loadedUsername}</div>
              </div>

              {profile?.bio && <p className="xt-bio">{profile.bio}</p>}

              {(profile?.location || profile?.website || profile?.joinDate) && (
                <div className="xt-meta">
                  {profile?.location && <span className="xt-meta-item">{profile.location}</span>}
                  {profile?.website && (
                    <span className="xt-meta-item">
                      <a className="xt-website" href={/^https?:\/\//.test(profile.website) ? profile.website : `https://${profile.website}`} target="_blank" rel="noopener noreferrer">
                        {profile.website.replace(/^https?:\/\//, '')}
                      </a>
                    </span>
                  )}
                  {profile?.joinDate && <span className="xt-meta-item">Joined {profile.joinDate}</span>}
                </div>
              )}

              {(profile?.following || profile?.followers) && (
                <div className="xt-stats">
                  {profile?.following && <span><strong>{profile.following}</strong> Following</span>}
                  {profile?.followers && <span><strong>{profile.followers}</strong> Followers</span>}
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="xt-tabs">
              <button
                className={`xt-tab ${activeTab === 'posts' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('posts')}
              >
                Posts
              </button>
              <button
                className={`xt-tab ${activeTab === 'replies' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('replies')}
              >
                Replies
              </button>
            </div>

            {/* Timeline — tweets stream in newest-first, so the top fills first
                while skeleton rows sit at the bottom as older ones arrive. */}
            <ul className="xt-tweet-list">
              {shown.map(tweet => (
                <TweetRow
                  key={tweetKey(tweet)}
                  tweet={tweet}
                  displayName={displayName}
                  handle={loadedUsername}
                  profileAvatarUrl={profileAvatarUrl}
                />
              ))}
              {Array.from({ length: skeletonCount }).map((_, i) => (
                <TweetSkeleton key={`sk-${i}`} />
              ))}
              {!streaming && !loadingMore && shown.length === 0 && (
                <li className="xt-empty">No {activeTab} found in the archive.</li>
              )}
              {/* Sentinel: when this scrolls into view, the next page loads. */}
              {hasMore && <li ref={sentinelRef} className="xt-sentinel" aria-hidden="true" />}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
