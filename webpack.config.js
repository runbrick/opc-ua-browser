const path = require('path');

module.exports = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  externals: {
    vscode: 'commonjs vscode',
    // 将 node-opcua 及其依赖设置为外部依赖，不打包进 bundle
    'node-opcua': 'commonjs node-opcua',
    'node-opcua-client': 'commonjs node-opcua-client',
    'node-opcua-secure-channel': 'commonjs node-opcua-secure-channel',
    'node-opcua-crypto': 'commonjs node-opcua-crypto',
    'node-opcua-transport': 'commonjs node-opcua-transport',
    'node-opcua-service-browse': 'commonjs node-opcua-service-browse',
    'node-opcua-service-read': 'commonjs node-opcua-service-read',
    'node-opcua-service-write': 'commonjs node-opcua-service-write',
    'node-opcua-address-space': 'commonjs node-opcua-address-space'
  },
  resolve: {
    extensions: ['.ts', '.js'],
    mainFields: ['main', 'module']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                module: 'commonjs'
              }
            }
          }
        ]
      },
      {
        test: /\.node$/,
        loader: 'node-loader'
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log"
  },
  node: {
    __dirname: false,
    __filename: false
  }
};
