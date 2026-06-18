# xTinct

a tool to view archived tweets from suspended or deleted twitter accounts using the wayback machine.

## what is this?

xTinct allows you to search for and view cached/captured tweets from twitter accounts that have been suspended, deleted, or otherwise made inaccessible. it works by querying the internet archive's wayback machine for historical snapshots of twitter profiles and extracting the tweet content from those archived pages.

## data sources

this application uses the following data sources:

- **wayback machine cdx api**: to find archived snapshots of twitter profile pages
- **wayback machine snapshots**: to extract tweet content from historical page captures
- **internet archive**: all data comes from publicly available web archives

## privacy & data handling

- **no data storage**: this tool does not store, cache, or persist any user data or tweet content
- **no user accounts**: the application does not require or collect any personal information
- **public data only**: all data accessed is from publicly available web archives
- **no tracking**: no analytics, cookies, or tracking mechanisms are implemented
- **rate limiting**: built-in concurrency controls to be respectful to the wayback machine's servers

## installation

### prerequisites

- node.js (version 18 or higher)
- npm

### setup

1. **clone the repository**
   ```bash
   git clone https://github.com/yourusername/xtinct.git
   cd xtinct
   ```

2. **install dependencies**
   ```bash
   # install root dependencies
   npm install
   
   # install wayback-twitter-app dependencies
   cd wayback-twitter-app
   npm install
   
   # install client dependencies
   cd client
   npm install
   
   # install server dependencies
   cd ../server
   npm install
   ```

## usage

### running the application

from the `wayback-twitter-app` directory:

```bash
# run both frontend and backend together
npm run dev

# or run them separately
npm run client  # frontend only
npm run server  # backend only
```

the application will be available at:
- frontend: `http://localhost:5173`
- backend api: `http://localhost:5174`

### using the tool

1. enter a twitter username (with or without @ symbol)
2. click "search" to find archived tweets
3. view the extracted tweet content and timestamps

### standalone script

you can also use the standalone script in the root directory:

```bash
node scrapeUsernames.js
```

edit the `TWEET_ID` variable in the script to search for a specific tweet.

## api endpoints

- `GET /api/tweets/:username` - fetch archived tweets for a given username

## technical details

- **frontend**: react with vite
- **backend**: express.js server
- **web scraping**: cheerio for html parsing
- **archival data**: wayback machine cdx api
- **concurrency control**: built-in rate limiting to respect server resources

## limitations

- **tweets load very slowly**  - due to concurrency limitations and continuous sequential fetches. working on optimizing this ASAP with batch processing.
- only works for accounts that were archived by the wayback machine for now
- tweet content extraction depends on the snapshot quality and twitter's page structure
- some tweets may be incomplete or missing due to archival gaps

## contributing

contributions are welcome! please feel free to submit issues, feature requests, or pull requests.

## license

mit license - see [license](license) file for details.

## disclaimer

this tool is for educational and research purposes. please respect:
- the wayback machine's terms of service
- twitter's terms of service
- the privacy of individuals whose content you may access
- rate limits and server resources

## todo

- [ ] implement pagination for large result sets
- [ ] improve performance/load times
- [ ] add filtering by date range
- [ ] add multimedia content extraction
- [ ] add export functionality (json, csv)
- [ ] implement mock-Twitter/X UI to display tweets for more intuitive UX
- [ ] add bulk username processing