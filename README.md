# 🐂 Bull Queue Dashboard

A beautiful, real-time dashboard for monitoring Bull queues with Redis. This dashboard provides a visual representation of all your Bull queues, including queue statistics, job counts, and detailed job information.

## Features

- 🔍 **Auto-discovery**: Automatically discovers all Bull queues in your Redis instance
- 📊 **Real-time monitoring**: Live updates every 5 seconds via WebSocket
- 📈 **Queue statistics**: Shows waiting, active, completed, failed, and delayed job counts
- 🔍 **Job details**: View individual job data, progress, and error information
- 📱 **Responsive design**: Works on desktop and mobile devices
- ⚡ **Fast and lightweight**: Built with vanilla JavaScript and minimal dependencies

## Screenshots

The dashboard shows:
- Overview statistics (total queues, jobs, active jobs, failed jobs)
- Individual queue cards with detailed statistics
- Job browser with different status tabs (waiting, active, completed, failed, delayed)
- Real-time connection status indicator

## Prerequisites

- Node.js 18+ 
- Redis server running
- Bull queues already created in your application

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the environment configuration:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` file with your Redis configuration:
   ```env
   REDIS_HOST=localhost
   REDIS_PORT=6379
   REDIS_PASSWORD=your_password_if_any
   REDIS_DB=0
   PORT=3000
   ```

## Usage

1. Start the dashboard:
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

3. The dashboard will automatically discover and display all Bull queues in your Redis instance.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_HOST` | Redis server hostname | `localhost` |
| `REDIS_PORT` | Redis server port | `6379` |
| `REDIS_PASSWORD` | Redis password (if required) | `undefined` |
| `REDIS_DB` | Redis database number | `0` |
| `PORT` | Dashboard server port | `3000` |

### Redis Connection

The dashboard connects to the same Redis instance that your Bull queues use. Make sure:

1. Redis is running and accessible
2. Your Bull queues are using the same Redis configuration
3. The dashboard has the necessary permissions to read from Redis

## API Endpoints

The dashboard exposes several API endpoints:

- `GET /api/queues` - Get all queue statistics
- `GET /api/queues/:queueName` - Get specific queue statistics  
- `GET /api/queues/:queueName/jobs/:status` - Get jobs by status (waiting, active, completed, failed, delayed)

## How It Works

1. **Queue Discovery**: The dashboard scans Redis for keys matching the Bull pattern (`bull:*`) to discover queues
2. **Statistics Collection**: For each discovered queue, it creates a Bull instance and collects statistics
3. **Real-time Updates**: WebSocket connection provides live updates every 5 seconds
4. **Job Browsing**: Click on any queue card to view detailed job information

## Troubleshooting

### No queues showing up?

1. Verify Redis connection settings in `.env`
2. Ensure your Bull queues are running and have created jobs
3. Check that you're connecting to the same Redis database (`REDIS_DB`)
4. Look at the browser console and server logs for error messages

### Connection issues?

1. Verify Redis is running: `redis-cli ping`
2. Check firewall settings if Redis is on a different server
3. Ensure Redis password is correct (if using authentication)

### Performance considerations

- The dashboard polls Redis every 5 seconds by default
- For high-traffic queues, consider increasing the refresh interval
- The dashboard shows the most recent jobs (Bull's default limit)

## Development

To contribute or modify the dashboard:

1. The main server code is in `server.js`
2. Frontend files are in the `public/` directory:
   - `index.html` - Main dashboard HTML
   - `styles.css` - Dashboard styling
   - `dashboard.js` - Frontend JavaScript logic

## Dependencies

- **express**: Web server framework
- **bull**: Queue library (for connecting to existing queues)
- **redis**: Redis client
- **socket.io**: Real-time WebSocket communication
- **cors**: Cross-origin resource sharing
- **dotenv**: Environment variable management

## License

ISC License - feel free to use this dashboard in your projects!

## Contributing

Pull requests are welcome! Please feel free to submit issues and enhancement requests.
