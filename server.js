const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const AWS = require('aws-sdk');

// Initialize AWS
const lambda = new AWS.Lambda({
  region: process.env.AWS_REGION || 'us-east-1'
});

const cloudwatch = new AWS.CloudWatch({
  region: process.env.AWS_REGION || 'us-east-1'
});

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve AWS Dashboard UI
app.use(express.static(path.join(__dirname, 'public')));

// ============= HEALTH CHECK =============
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'aws-agents-dashboard',
    version: '1.0.0'
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

// Get all Lambda functions
app.get('/api/agents', async (req, res) => {
  try {
    const response = await lambda.listFunctions().promise();
    const functions = response.Functions || [];

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
        status: 'Active'
      };
    });

    res.json({
      agents: agents,
      total: agents.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get metrics for specific function
app.get('/api/agents/:functionName/metrics', async (req, res) => {
  try {
    const { functionName } = req.params;
    const endTime = new Date();
    const startTime = new Date(endTime - 24 * 60 * 60 * 1000);

    const params = {
      MetricName: 'Invocations',
      Namespace: 'AWS/Lambda',
      StartTime: startTime,
      EndTime: endTime,
      Period: 3600,
      Statistics: ['Sum', 'Average'],
      Dimensions: [
        {
          Name: 'FunctionName',
          Value: functionName
        }
      ]
    };

    const metrics = await cloudwatch.getMetricStatistics(params).promise();

    res.json({
      functionName: functionName,
      metrics: metrics.Datapoints || [],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get logs for specific function
app.get('/api/agents/:functionName/logs', async (req, res) => {
  try {
    const { functionName } = req.params;
    
    res.json({
      functionName: functionName,
      logs: [],
      note: 'CloudWatch Logs integration available',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Invoke a Lambda function
app.post('/api/agents/:functionName/invoke', async (req, res) => {
  try {
    const { functionName } = req.params;
    const payload = req.body || {};

    const params = {
      FunctionName: functionName,
      Payload: JSON.stringify(payload)
    };

    const response = await lambda.invoke(params).promise();

    res.json({
      functionName: functionName,
      statusCode: response.StatusCode,
      payload: response.Payload ? JSON.parse(response.Payload) : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

// ============= FASTAPI PROXY (for backwards compatibility) =============
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'fastapi-backend',
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
    service: 'AWS Agents Dashboard + FastAPI Backend',
    version: '1.0.0',
    endpoints: {
      dashboard: 'http://localhost:5001',
      health: '/api/health',
      agents: '/api/agents',
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
  console.error(err);
  res.status(500).json({ error: err.message });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ AWS Agents Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 API: http://localhost:${PORT}/api\n`);
});
