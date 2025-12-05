const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const AWS = require('aws-sdk');

// Configure AWS with explicit credentials from environment
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  maxRetries: 3
});

// Initialize AWS
const lambda = new AWS.Lambda({
  region: process.env.AWS_REGION || 'us-east-1'
});

const cloudwatch = new AWS.CloudWatch({
  region: process.env.AWS_REGION || 'us-east-1'
});

const logs = new AWS.CloudWatchLogs({
  region: process.env.AWS_REGION || 'us-east-1'
});

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve AWS Dashboard UI
app.use(express.static(path.join(__dirname, 'public')));

// Debug logging
console.log(`[AWS Config] Region: ${process.env.AWS_REGION || 'us-east-1'}`);
console.log(`[AWS Config] Has Access Key: ${!!process.env.AWS_ACCESS_KEY_ID}`);
console.log(`[AWS Config] Has Secret Key: ${!!process.env.AWS_SECRET_ACCESS_KEY}`);

// ============= HEALTH CHECK =============
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'aws-agents-dashboard',
    version: '2.0.0',
    aws_configured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  });
});

// ============= AWS LAMBDA INTEGRATION =============

// Lambda function categories
const lambdaCategories = {
  'Bookmark Management': [
    'addBookmark-main', 'addBookmark-dev',
    'removeBookmark-main', 'removeBookmark-dev',
    'getBookmarkStatus-main', 'getBookmarkStatus-dev',
    'fetchBookmarks-main', 'fetchBookmarks-dev'
  ],
  'Opportunity Processing': [
    'fetchOpportunity-main', 'fetchOpportunity-dev',
    'fetchOpportunities-main', 'fetchOpportunities-dev',
    'OpportunityCsvLoader', 'opDelta-main'
  ],
  'Text Extraction': [
    'PDFTextExtractor', 'tiffMetaExtractor',
    'pdf-extractor', 'extractTextFromPDF'
  ],
  'Statistics': [
    'fetchStats-main', 'fetchStats-dev'
  ],
  'Authentication': [
    'cognitoCustomMessage-main', 'cognitoCustomMessage-dev',
    'cognitoPostAuth-main', 'cognitoPostAuth-dev',
    'cognitoPreAuth-main', 'cognitoPreAuth-dev',
    'cognitoPostConfirmation-main', 'cognitoPostConfirmation-dev',
    'cognitoUserMigration'
  ],
  'Data Processing': [
    'instructionPrompt-main', 'instructionPrompt-dev',
    'instructionPrompt-uat', 'instructionPrompt-prod',
    'syntheticlab-query-service', 'cloudwatch-converter',
    'datadog-importer'
  ],
  'Utilities': [
    'ResourceExplorer', 'govpulse-landingpage-signup',
    'govpulse-signup'
  ]
};

// Cache for function details
const functionDetailsCache = new Map();

// Get all Lambda functions
app.get('/api/agents', async (req, res) => {
  try {
    console.log('[API] Fetching Lambda functions...');
    
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      return res.status(401).json({ 
        error: 'AWS credentials not configured',
        message: 'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables'
      });
    }

    const response = await lambda.listFunctions().promise();
    const functions = response.Functions || [];

    console.log(`[API] Found ${functions.length} Lambda functions`);

    const agents = functions.map(fn => {
      let category = 'Utilities';
      for (const [cat, names] of Object.entries(lambdaCategories)) {
        if (names.some(name => fn.FunctionName.includes(name) || fn.FunctionName === name)) {
          category = cat;
          break;
        }
      }

      return {
        name: fn.FunctionName,
        runtime: fn.Runtime,
        memory: fn.MemorySize,
        timeout: fn.Timeout,
        codeSize: fn.CodeSize,
        category: category,
        lastModified: fn.LastModified,
        status: 'Active',
        arn: fn.FunctionArn
      };
    });

    res.json({
      agents: agents,
      total: agents.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[API Error]', error.message);
    res.status(500).json({ 
      error: error.message,
      type: error.code,
      detail: error.statusCode
    });
  }
});

// Get agent details and execution history
app.get('/api/agents/:functionName/details', async (req, res) => {
  try {
    const { functionName } = req.params;
    console.log(`[API] Fetching details for: ${functionName}`);

    // Get function configuration
    const configResponse = await lambda.getFunction({ FunctionName: functionName }).promise();
    const config = configResponse.Configuration;

    // Get execution metrics
    const endTime = new Date();
    const startTime = new Date(endTime - 24 * 60 * 60 * 1000);

    const invocationMetrics = await cloudwatch.getMetricStatistics({
      MetricName: 'Invocations',
      Namespace: 'AWS/Lambda',
      StartTime: startTime,
      EndTime: endTime,
      Period: 3600,
      Statistics: ['Sum', 'Average'],
      Dimensions: [{
        Name: 'FunctionName',
        Value: functionName
      }]
    }).promise();

    const errorMetrics = await cloudwatch.getMetricStatistics({
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      StartTime: startTime,
      EndTime: endTime,
      Period: 3600,
      Statistics: ['Sum'],
      Dimensions: [{
        Name: 'FunctionName',
        Value: functionName
      }]
    }).promise();

    const durationMetrics = await cloudwatch.getMetricStatistics({
      MetricName: 'Duration',
      Namespace: 'AWS/Lambda',
      StartTime: startTime,
      EndTime: endTime,
      Period: 3600,
      Statistics: ['Average', 'Maximum'],
      Dimensions: [{
        Name: 'FunctionName',
        Value: functionName
      }]
    }).promise();

    // Calculate summary stats
    const invocations = invocationMetrics.Datapoints || [];
    const errors = errorMetrics.Datapoints || [];
    const durations = durationMetrics.Datapoints || [];

    const totalInvocations = invocations.reduce((sum, dp) => sum + (dp.Sum || 0), 0);
    const totalErrors = errors.reduce((sum, dp) => sum + (dp.Sum || 0), 0);
    const avgDuration = durations.length > 0 
      ? durations.reduce((sum, dp) => sum + (dp.Average || 0), 0) / durations.length 
      : 0;

    const summary = {
      name: functionName,
      runtime: config.Runtime,
      memory: config.MemorySize,
      timeout: config.Timeout,
      codeSize: config.CodeSize,
      lastModified: config.LastModified,
      description: config.Description,
      environment: config.Environment?.Variables ? Object.keys(config.Environment.Variables) : [],
      
      // 24-hour metrics
      metrics: {
        totalInvocations: Math.round(totalInvocations),
        totalErrors: Math.round(totalErrors),
        successRate: totalInvocations > 0 
          ? ((totalInvocations - totalErrors) / totalInvocations * 100).toFixed(2) + '%'
          : 'N/A',
        averageDuration: Math.round(avgDuration) + 'ms',
        maxDuration: durations.length > 0 
          ? Math.max(...durations.map(d => d.Maximum || 0)) + 'ms'
          : 'N/A'
      },

      // Recent activity (last 24 hours)
      recentActivity: {
        invocations: invocations.map(dp => ({
          timestamp: dp.Timestamp,
          count: dp.Sum || 0
        })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10),
        errors: errors.map(dp => ({
          timestamp: dp.Timestamp,
          count: dp.Sum || 0
        })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10)
      }
    };

    res.json(summary);
  } catch (error) {
    console.error('[API Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get CloudWatch logs for a function
app.get('/api/agents/:functionName/logs', async (req, res) => {
  try {
    const { functionName } = req.params;
    const logGroupName = `/aws/lambda/${functionName}`;

    console.log(`[API] Fetching logs for: ${functionName}`);

    // Get recent log streams
    const streamsResponse = await logs.describeLogStreams({
      logGroupName: logGroupName,
      orderBy: 'LastEventTime',
      descending: true,
      limit: 5
    }).promise();

    const streams = streamsResponse.logStreams || [];
    const logEvents = [];

    // Get events from recent streams
    for (const stream of streams.slice(0, 3)) {
      try {
        const eventsResponse = await logs.getLogEvents({
          logGroupName: logGroupName,
          logStreamName: stream.logStreamName,
          limit: 10,
          startFromHead: false
        }).promise();

        logEvents.push(...(eventsResponse.events || []).map(e => ({
          timestamp: new Date(e.timestamp).toISOString(),
          message: e.message,
          stream: stream.logStreamName
        })));
      } catch (err) {
        console.log(`Could not fetch from stream: ${stream.logStreamName}`);
      }
    }

    res.json({
      functionName: functionName,
      logGroup: logGroupName,
      recentLogs: logEvents
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, 20),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[API Error]', error.message);
    res.status(500).json({ 
      error: error.message,
      note: 'CloudWatch Logs might not be available for this function'
    });
  }
});

// Invoke a Lambda function with test data
app.post('/api/agents/:functionName/invoke', async (req, res) => {
  try {
    const { functionName } = req.params;
    const payload = req.body || { test: true };

    console.log(`[API] Invoking: ${functionName}`);

    const response = await lambda.invoke({
      FunctionName: functionName,
      Payload: JSON.stringify(payload),
      LogType: 'Tail'
    }).promise();

    const result = {
      functionName: functionName,
      statusCode: response.StatusCode,
      executedVersion: response.ExecutedVersion,
      logResult: response.LogResult ? Buffer.from(response.LogResult, 'base64').toString('utf8') : null,
      payload: response.Payload ? JSON.parse(response.Payload) : null,
      timestamp: new Date().toISOString()
    };

    res.json(result);
  } catch (error) {
    console.error('[API Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get dashboard statistics
app.get('/api/stats', async (req, res) => {
  try {
    const response = await lambda.listFunctions().promise();
    const functions = response.Functions || [];

    const stats = {
      totalFunctions: functions.length,
      totalMemory: functions.reduce((sum, fn) => sum + fn.MemorySize, 0),
      categories: Object.keys(lambdaCategories).length,
      runtimes: [...new Set(functions.map(fn => fn.Runtime))],
      timestamp: new Date().toISOString()
    };

    res.json(stats);
  } catch (error) {
    console.error('[API Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============= FASTAPI PROXY (for backwards compatibility) =============
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'aws-agents-dashboard',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/hello/:name', (req, res) => {
  const { name } = req.params;
  res.json({
    message: `Hello, ${name}!`,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/echo', (req, res) => {
  res.json({
    echo: req.body,
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'AWS Agents Dashboard',
    version: '2.0.0',
    endpoints: {
      dashboard: '/',
      health: '/api/health',
      agents: '/api/agents',
      agentDetails: '/api/agents/:functionName/details',
      agentLogs: '/api/agents/:functionName/logs',
      agentInvoke: 'POST /api/agents/:functionName/invoke',
      stats: '/api/stats'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error Handler]', err);
  res.status(500).json({ error: err.message });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ AWS Agents Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 API: http://localhost:${PORT}/api\n`);
});
