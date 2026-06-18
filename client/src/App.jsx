import { useState, useRef } from 'react'
import axios from 'axios'
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

function App() {
  const [username, setUsername] = useState('')
  const [tweets, setTweets] = useState([])
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [error, setError] = useState('')
  const [hasSearched, setHasSearched] = useState(false)
  const eventSourceRef = useRef(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setTweets([])
    setProgress({ loaded: 0, total: 0 })
    setHasSearched(true)
    if (!username.trim()) return
    
    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }
    
    setStreaming(true)
    setLoading(true)
    
    try {
      const eventSource = new EventSource(`/api/tweets/stream/${username.replace(/^@/, '')}`)
      eventSourceRef.current = eventSource
      
      eventSource.onmessage = (event) => {
        const { type, data } = JSON.parse(event.data)
        
        switch (type) {
          case 'progress':
            setProgress(data)
            break
          case 'tweet':
            setTweets(prev => {
              const newTweets = [...prev, data]
              // Sort by timestamp (newest first) as we add tweets
              return newTweets.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            })
            break
          case 'complete':
            setStreaming(false)
            setLoading(false)
            eventSource.close()
            // Check if we actually have tweets by looking at the current state
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

  const handleDisplay = username.trim() ? '@' + username.replace(/^@/, '') : ''

  const handleTitleClick = () => {
    setHasSearched(false)
    setUsername('')
    setTweets([])
    setError('')
    setProgress({ loaded: 0, total: 0 })
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }
  }

  return (
    <div>
      {!hasSearched ? (
        // Title screen - centered layout
        <div className="tw-title-screen">
          <div className="tw-title-container">
            <h1 className="tw-title-large">xTinct</h1>
            <p className="tw-subtitle">this tool surfaces already-archived tweets from the <a href="https://wayback.archive.org" target="_blank" rel="noopener noreferrer">Wayback Machine</a> in a readable timeline view for research and preservation.</p>
            <form onSubmit={handleSubmit} className="tw-search-form-centered">
              <input
                className="tw-input"
                type="text"
                placeholder="@username"
                value={`@${username}`}
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
        // Results screen - current layout
        <>
          <header className="tw-topbar">
            <div className="tw-container">
              <div className="tw-brand" onClick={handleTitleClick} style={{ cursor: 'pointer' }}>xTinct</div>
            </div>
          </header>

          <main className="tw-container">
            <section className="tw-search">
              <form onSubmit={handleSubmit} className="tw-search-form">
                <input
                  className="tw-input"
                  type="text"
                  placeholder="@username"
                  value={`@${username}`}
                  onChange={e => setUsername(e.target.value.replace(/^@/, ''))}
                  spellCheck="false"
                />
                <button type="submit" className="tw-btn" disabled={loading}>
                  {loading ? 'Searching...' : 'Search'}
                </button>
              </form>
              {error && <div className="tw-error">{error}</div>}
            </section>

            {/* Progress indicator */}
            {streaming && progress.total > 0 && (
              <div className="tw-progress-container">
                <div className="tw-progress-bar">
                  <div 
                    className="tw-progress-fill" 
                    style={{ width: `${(progress.loaded / progress.total) * 100}%` }}
                  ></div>
                </div>
            <div className="tw-progress-text">
              Loading tweets...
            </div>
              </div>
            )}


            <ul className="tw-tweet-list">
              {tweets.map((tweet, i) => (
                <li key={`${tweet.timestamp}-${i}`} className="tw-tweet">
                  <div className="tw-avatar" aria-hidden="true"></div>
                  <div className="tw-tweet-body">
                    <div className="tw-tweet-header">
                      {handleDisplay && <span className="tw-name">{handleDisplay}</span>}
                      {handleDisplay && <span className="tw-dot">·</span>}
                      <time className="tw-time">{formatDate(tweet.timestamp)}</time>
                    </div>
                    <div className="tw-text">{tweet.text}</div>
                  </div>
                </li>
              ))}
            </ul>
          </main>
        </>
      )}
    </div>
  )
}

export default App
