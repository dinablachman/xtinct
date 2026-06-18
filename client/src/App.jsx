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

// Memoized row so already-rendered tweets don't re-render as new ones stream in.
const TweetRow = memo(function TweetRow({ tweet, displayName, handle, profileAvatarUrl }) {
  const avatarUrl = tweet.avatarUrl || profileAvatarUrl
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
          {tweet.isReply ? (stripLeadingMentions(tweet.text) || tweet.text) : tweet.text}
        </div>
        {tweet.media && tweet.media.length > 0 && (
          <div className="xt-media">
            {tweet.media.map((m, idx) => (
              <img key={idx} src={m} alt="" loading="lazy" />
            ))}
          </div>
        )}
      </div>
    </li>
  )
})

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
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const eventSourceRef = useRef(null)
  const sentinelRef = useRef(null)
  // The page most recently loaded, and a guard so we never start two page
  // loads at once. Refs (not state) so the IntersectionObserver always reads
  // the latest value without needing to re-subscribe.
  const pageRef = useRef(0)
  const loadingRef = useRef(false)
  // Incoming tweets are buffered and flushed in chunks (rather than one state
  // update per tweet) so the timeline grows smoothly instead of thrashing.
  const tweetBufferRef = useRef([])
  const flushTimerRef = useRef(null)

  const cleanUsername = username.replace(/^@/, '')
  const displayName = profile?.displayName || loadedUsername || 'Unknown'

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
      const next = prev.concat(additions)
      next.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      return next
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

    loadingRef.current = true
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
        loadingRef.current = false
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
            // Keep the first profile we recover; later pages resend the same.
            setProfile(prev => prev || data)
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
            pageRef.current = pageNum
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
      loadingRef.current = false
      setStreaming(false)
      setLoading(false)
      setLoadingMore(false)
    }
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
    setHasSearched(true)
    if (!cleanUsername.trim()) return
    setLoadedUsername(cleanUsername)
    pageRef.current = 0
    loadPage(cleanUsername, 0, false)
  }

  // Infinite scroll: when the sentinel near the bottom of the list scrolls into
  // view, load the next page. Refs hold the live page/loading state so the
  // observer doesn't need to be torn down and rebuilt on every tweet.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver((entries) => {
      if (
        entries[0].isIntersecting &&
        hasMore &&
        !loadingRef.current &&
        loadedUsername
      ) {
        loadPage(loadedUsername, pageRef.current + 1, true)
      }
    }, { rootMargin: '600px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadedUsername])

  const handleTitleClick = () => {
    setHasSearched(false)
    setUsername('')
    setLoadedUsername('')
    clearTweetBuffer()
    setTweets([])
    setProfile(null)
    setActiveTab('posts')
    setError('')
    setProgress({ loaded: 0, total: 0 })
    setHasMore(false)
    pageRef.current = 0
    loadingRef.current = false
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

            {/* Banner (placeholder) */}
            <div className="xt-banner" aria-hidden="true" />

            {/* Profile header card */}
            <div className="xt-header">
              <div className="xt-avatar-wrap">
                {profile?.avatarUrl ? (
                  <img className="xt-avatar-img" src={profile.avatarUrl} alt={displayName} />
                ) : (
                  <DefaultAvatar className="xt-avatar-img xt-avatar-placeholder" />
                )}
              </div>

              <div className="xt-identity">
                <div className="xt-display-name">{displayName}</div>
                <div className="xt-handle">@{loadedUsername}</div>
              </div>

              <p className="xt-bio xt-placeholder-text">no bio recovered from the archive yet</p>

              <div className="xt-meta">
                <span className="xt-meta-item">Location unknown</span>
                <span className="xt-meta-item">Joined &mdash;</span>
              </div>

              <div className="xt-stats">
                <span><strong>&mdash;</strong> Following</span>
                <span><strong>&mdash;</strong> Followers</span>
              </div>
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
                and a "loading more" row sits at the bottom as older ones arrive. */}
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
              {(streaming || loadingMore) && (
                <li className="xt-loading-row">
                  <span className="xt-spinner" aria-hidden="true" />
                  <span>
                    {streaming && progress.total === 0
                      ? 'Searching the archive…'
                      : loadingMore
                        ? 'Loading more tweets…'
                        : `Loading archived tweets… ${progress.loaded}/${progress.total}`}
                  </span>
                </li>
              )}
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
