import { useState, useRef, useMemo } from 'react'
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

function App() {
  const [username, setUsername] = useState('')
  const [tweets, setTweets] = useState([])
  const [profile, setProfile] = useState(null)
  const [activeTab, setActiveTab] = useState('posts')
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const eventSourceRef = useRef(null)

  const cleanUsername = username.replace(/^@/, '')
  const displayName = profile?.displayName || cleanUsername || 'Unknown'

  const posts = useMemo(() => tweets.filter(t => !t.isReply), [tweets])
  const replies = useMemo(() => tweets.filter(t => t.isReply), [tweets])
  const shown = activeTab === 'posts' ? posts : replies

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setTweets([])
    setProfile(null)
    setActiveTab('posts')
    setProgress({ loaded: 0, total: 0 })
    setHasSearched(true)
    if (!cleanUsername.trim()) return

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    setStreaming(true)
    setLoading(true)

    try {
      const eventSource = new EventSource(`/api/tweets/stream/${cleanUsername}`)
      eventSourceRef.current = eventSource

      eventSource.onmessage = (event) => {
        const { type, data } = JSON.parse(event.data)

        switch (type) {
          case 'progress':
            setProgress(data)
            break
          case 'profile':
            setProfile(data)
            break
          case 'tweet':
            setTweets(prev => {
              const newTweets = [...prev, data]
              return newTweets.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            })
            break
          case 'complete':
            setStreaming(false)
            setLoading(false)
            eventSource.close()
            setTweets(currentTweets => {
              if (currentTweets.length === 0) setError('No archived tweets found.')
              return currentTweets
            })
            break
          case 'error':
            setError(data.message || 'Failed to fetch tweets.')
            setStreaming(false)
            setLoading(false)
            eventSource.close()
            break
        }
      }

      eventSource.onerror = () => {
        setError('Connection lost. Please try again.')
        setStreaming(false)
        setLoading(false)
        eventSource.close()
      }

    } catch (err) {
      setError('Failed to connect to server.')
      setStreaming(false)
      setLoading(false)
    }
  }

  const handleTitleClick = () => {
    setHasSearched(false)
    setUsername('')
    setTweets([])
    setProfile(null)
    setActiveTab('posts')
    setError('')
    setProgress({ loaded: 0, total: 0 })
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }
  }

  const renderTweet = (tweet, i) => (
    <li key={`${tweet.timestamp}-${i}`} className="xt-tweet">
      <div className="xt-tweet-avatar">
        {tweet.avatarUrl || profile?.avatarUrl ? (
          <img src={tweet.avatarUrl || profile.avatarUrl} alt="" loading="lazy" />
        ) : (
          <DefaultAvatar className="xt-avatar-placeholder" />
        )}
      </div>
      <div className="xt-tweet-main">
        <div className="xt-tweet-head">
          <span className="xt-tweet-name">{displayName}</span>
          <span className="xt-tweet-handle">@{cleanUsername}</span>
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
                <div className="xt-handle">@{cleanUsername}</div>
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
                Posts <span className="xt-tab-count">{posts.length}</span>
              </button>
              <button
                className={`xt-tab ${activeTab === 'replies' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('replies')}
              >
                Replies <span className="xt-tab-count">{replies.length}</span>
              </button>
            </div>

            {/* Loading progress */}
            {streaming && progress.total > 0 && (
              <div className="xt-loading">
                <div className="xt-progress-bar">
                  <div
                    className="xt-progress-fill"
                    style={{ width: `${(progress.loaded / progress.total) * 100}%` }}
                  />
                </div>
                <span>Loading archived tweets… {progress.loaded}/{progress.total}</span>
              </div>
            )}

            {/* Timeline */}
            <ul className="xt-tweet-list">
              {shown.map(renderTweet)}
              {!streaming && shown.length === 0 && (
                <li className="xt-empty">No {activeTab} found in the archive.</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
