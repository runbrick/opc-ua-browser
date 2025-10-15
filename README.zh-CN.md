# OPC UA Browser

OPC UA Browser 是一款运行在 Visual Studio Code 中的扩展，可帮助您在编辑器内直接浏览和交互 OPC UA 服务器。它面向自动化、工业控制和 OT 工程师，让您能够查看地址空间、监控实时数值，并导出标签清单。

## 功能特点

- 管理多个 OPC UA 端点，持久保存连接配置、安全模式和凭证信息。
- 在连接之前执行端点发现，根据服务器返回的安全模式/安全策略组合自动填充表单。
- 在活动栏提供独立的 OPC UA 视图，带有连接状态指示，并可选择显示非层级引用。
- 打开节点详情面板查看属性、实时数值与引用列表，面板保持每秒自动刷新。
- 构建数据视图，跟踪关键节点，两秒刷新一次并支持自定义显示列。
- 支持在单个或全部已连接服务器中搜索节点，可通过显示名、浏览名或 NodeId 模式匹配，并可在树中自动定位结果。
- 将变量类节点导出为 Excel 工作簿，可选择仅导出单个节点或递归导出整棵子树，并自动生成摘要页。
- 所有操作均可通过命令面板、活动栏工具栏或上下文菜单快捷访问。

## 环境要求

- Visual Studio Code 1.75 或更高版本（与扩展 package.json 中 `engines.vscode` 声明一致）。
- 可以访问的 OPC UA 服务器，且您拥有合法的浏览权限。
- 若服务器禁止匿名访问，则需要对应的凭证。

## 安装方式

### 从 VSCode 市场安装

1. 打开 Visual Studio Code。
2. 进入扩展视图（Windows/Linux 使用 `Ctrl+Shift+X`，macOS 使用 `Cmd+Shift+X`）。
3. 搜索 **OPC UA Browser** 并点击 **Install**。
4. 如提示，请重载 VS Code。

### 手动安装 VSIX

1. 从项目发布页下载最新的 `opcua-browser-<version>.vsix` 包（例如 `https://github.com/runbrick/opc-client/releases`）。
2. 在 VS Code 中运行命令面板指令 `Extensions: Install from VSIX...`。
3. 选择下载的 VSIX 文件，安装完成后重新加载 VS Code。

## 快速上手

1. 打开活动栏中的 **OPC UA Browser** 视图。
2. 点击 **Add Connection**（或运行 `OPC UA Browser: Add Connection` 命令）。
3. 输入显示名称和端点地址，或者点击 **Discover Endpoints** 获取可用的安全配置。
4. 选择所需的安全模式、安全策略和认证方式。
5. 保存配置后，在连接节点的上下文菜单中选择 **Connect**。
6. 展开树状结构即可浏览节点或打开节点详情面板。

## 管理连接

### 新增连接

- 使用 OPC UA Browser 树视图顶部的工具栏按钮，或运行 `OPC UA Browser: Add Connection`。
- 连接编辑器支持：
  - 设置显示名称与端点 URL（默认前缀为 `opc.tcp://`）。
  - 执行 **Discover Endpoints**，从服务器拉取匹配的安全模式/策略组合。
  - 在 `Anonymous` 与 `User & Password` 认证方式间切换。
  - 当选择账号密码认证时，可选择是否保存用户名和密码。
- 保存后的连接配置会存储在扩展的全局状态中，在 VS Code 重启后仍可使用。

### 编辑或删除连接

- 在连接节点上点击右键选择 **Edit Connection**，或运行 `OPC UA Browser: Edit Connection`。
  - 编辑时可勾选 **Clear stored password** 以移除已保存的密码。
- 使用 **Delete Connection** 删除连接，系统会弹出二次确认提示。
- 运行 `OPC UA Browser: Refresh Connections` 刷新连接状态，适用于服务器状态发生变化的情况。

### 连接状态提示

- 图标和描述反映当前状态：
  - **Connected**：绿色图标（`vm-connect`），说明已连接，同时显示是否包含非层级引用。
  - **Connecting...**：旋转图标（`sync~spin`）。
  - **Error / Disconnected**：表示连接失败或断开。
- 通过上下文菜单的 **Connect** / **Disconnect** 选项即可控制会话。

### 切换非层级引用

- 部分 OPC UA 服务器的重要节点通过非层级引用暴露。
- 在连接节点上运行 `OPC UA Browser: Toggle Non-Hierarchical References` 可按连接维度切换显示或隐藏。
- 每个连接的显示偏好都会被记住，直到下一次切换。

## 浏览地址空间

- 展开连接节点即可看到 `RootFolder` 下的根节点。
- 逐层展开子节点浏览地址空间，图标对应 OPC UA 节点类型（对象、变量、方法等）。
- 双击节点或选择 **Show Node Details** 可打开节点详情面板。
- 鼠标悬停可查看完整 NodeId 作为提示信息。

## 节点详情面板

- 可通过命令 `OPC UA Browser: Show Node Details`、树节点默认双击操作或上下文菜单打开。
- 功能包括：
  - 展示节点属性：当前值、数据类型、访问级别、时间戳等。
  - 列出正向与反向引用，并按引用类型分组。
  - 面板打开期间每秒自动刷新，无需手动操作。
- 如果连接断开，面板会显示错误提示，重新连线后即可恢复。

## 数据视图实时监控

- 在树节点上选择 **Add Node to Data View**（或执行 `OPC UA Browser: Add Node to Data View`）将节点加入监控列表。
- 通过树视图工具栏、上下文菜单或命令 `OPC UA Browser: Open Data View` 打开数据视图面板。
- 数据视图提供：
  - 每两秒刷新一次的实时表格。
  - 可配置列（数值、数据类型、状态码、时间戳、连接名、NodeId、描述、节点类型等），使用 **Configure Columns** 调整布局。
  - 行内删除按钮以及 **Clear All** 用于清空全部条目。
  - 状态栏显示最近一次刷新结果和提示信息。
- 数据视图中的节点在 VS Code 重启后会继续保留，只要对应连接在线就会继续更新。

## 搜索节点

- 运行 `OPC UA Browser: Search Nodes` 即可在所有已连接服务器中搜索；在具体连接节点上选择 **Search Nodes in Connection** 可限定范围。
- 搜索面板支持：
  - 按显示名称、浏览名称进行文本搜索。
  - 使用 `ns=2;s=Machine/1/Temperature` 等 NodeId 模式（输入会自动规范化）。
  - 选择搜索范围（所有连接或单个连接），并展示每个连接的进度。
  - 在搜索过程中随时取消操作。
- 双击结果或点击 **Reveal in Tree** 会展开树结构并自动打开对应节点的详情面板。

## 导出 Excel

- 在任何节点上点击右键选择 **Export Node to Excel**，或运行命令 `OPC UA Browser: Export Node to Excel`。
- 选择保存位置，并决定是仅导出当前节点还是递归导出子节点（内部有深度限制，避免无限遍历）。
- 仅导出 OPC UA 中的变量类节点，如未找到变量节点，扩展会在写入文件前提示。
- 导出的工作簿包括：
  - 以根节点名称命名的工作表（超过 31 个字符会自动截断），包含 NodeId、Display Name、Browse Name、Data Type 列。
  - 一个 `Summary` 表，列出变量节点总数、根节点基本信息和导出时间戳。

## 支持的命令

| 命令 | 说明 |
| --- | --- |
| `OPC UA Browser: Add Connection` | 打开连接编辑器，新增服务器配置。 |
| `OPC UA Browser: Refresh Connections` | 刷新连接状态并重新载入树结构。 |
| `OPC UA Browser: Connect` | 与选中的服务器建立会话。 |
| `OPC UA Browser: Disconnect` | 断开当前会话。 |
| `OPC UA Browser: Toggle Non-Hierarchical References` | 切换是否显示非层级引用。 |
| `OPC UA Browser: Edit Connection` | 编辑现有连接配置。 |
| `OPC UA Browser: Delete Connection` | 删除已保存的连接。 |
| `OPC UA Browser: Show Node Details` | 打开节点详情面板。 |
| `OPC UA Browser: Add Node to Data View` | 将节点加入数据视图实时监控。 |
| `OPC UA Browser: Open Data View` | 打开或聚焦数据视图面板。 |
| `OPC UA Browser: Export Node to Excel` | 将变量节点导出到 Excel 文件。 |
| `OPC UA Browser: Search Nodes` | 在所有已连接服务器中搜索节点。 |
| `OPC UA Browser: Search Nodes in Connection` | 在指定服务器中搜索节点。 |

## 数据持久化与安全

- 连接配置和数据视图条目保存在 VS Code 的全局状态中，仅对当前用户可见。如不再需要，可在 UI 中删除。
- 保存的密码使用 VS Code 的存储机制，不包含额外加密。请勿在公共或共享机器上保存凭证，并在编辑连接时使用 **Clear stored password** 以清除密码。
- Excel 导出仅写入您指定的本地路径，扩展不会将数据发送至远端服务。

## 故障排查

- **无法连接**：检查端点 URL、防火墙与网络访问权限，并确认安全模式/策略与服务器配置一致。可使用 **Discover Endpoints** 校验配置。
- **认证失败**：重新输入凭证，检查服务器权限，或在允许的情况下改用匿名访问。
- **树中无子节点**：确认连接状态为 Connected，如服务器使用非标准引用可尝试切换非层级引用。
- **节点详情面板提示未连接**：重新连接服务器，或在连接恢复后重新打开面板。
- **数据视图显示错误**：确保对应连接保持在线。如服务器更改了命名空间，可尝试删除并重新添加节点。
- **搜索无结果**：扩大搜索范围、确认连接已在线，或使用完整 NodeId 进行搜索。

## 支持与反馈

请通过项目仓库的 Issue 区反馈问题或提交功能请求（例如 `https://github.com/runbrick/opc-client/issues`）。建议在反馈时附上 VS Code 版本、扩展版本及相关日志信息，以便快速定位问题。

## 许可证

本扩展基于 MIT License 分发，详情请参见 `LICENSE` 文件。

