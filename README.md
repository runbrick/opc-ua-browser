# OPC UA Browser

OPC UA Browser is a Visual Studio Code extension for exploring and interacting with OPC UA servers directly inside the editor. It helps controls and OT engineers inspect server address spaces, monitor live values, and export tag inventories without leaving VS Code.

## Features

- Manage multiple OPC UA endpoints with persistent connection profiles, security selections, and credential options.
- Discover server endpoints to pre-fill compatible security mode and security policy pairs before connecting.
- Browse the complete address space from a dedicated Activity Bar view with status-aware connection nodes and optional non-hierarchical references.
- Inspect node attributes, live values, and references in a docked node detail panel that updates every second while the panel is visible.
- Build a Data View of important nodes, track live values with a two-second refresh cadence, and customize the visible columns.
- Search across one or all connected servers by display name, browse name, or explicit NodeId patterns, then reveal results back in the tree.
- Export variable nodes to an Excel workbook (single node or recursive subtree) with an automatic summary sheet.
- Access every workflow through the command palette, Activity Bar toolbar, or context menus for efficient keyboard-driven usage.

## Requirements

- Visual Studio Code 1.75 or later (matches the `engines.vscode` range declared by the extension).
- Network access to one or more OPC UA servers that you are authorized to browse.
- Credentials for secured endpoints when anonymous access is not permitted.

## Installation

### Visual Studio Marketplace

1. Launch Visual Studio Code.
2. Open the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS).
3. Search for **OPC UA Browser**, then choose **Install**.
4. Reload VS Code if prompted.

### Manual install from VSIX

1. Download the latest `opcua-browser-<version>.vsix` package from the project releases (for example `https://github.com/runbrick/opc-client/releases`).
2. In VS Code, open the command palette and run `Extensions: Install from VSIX...`.
3. Select the downloaded VSIX file and restart VS Code when the installation completes.

## Quick Start

1. Open the **OPC UA Browser** view in the Activity Bar.
2. Click **Add Connection** (or run `OPC UA Browser: Add Connection` from the command palette).
3. Enter a display name and endpoint URL, or use **Discover Endpoints** to fetch available security pairs.
4. Choose the required security mode, security policy, and authentication type.
5. Save the connection, then select **Connect** from the connection node’s context menu.
6. Expand the connection in the tree to browse nodes or open the node detail panel.

## Managing Connections

### Adding a connection

- Use the **Add Connection** toolbar button in the OPC UA Browser tree, or run `OPC UA Browser: Add Connection`.
- The connection editor supports:
  - Custom display name and endpoint URL (default prefix `opc.tcp://`).
  - **Discover Endpoints** to poll the server and populate matching security mode/policy combinations.
  - Selection between `Anonymous` and `User & Password` authentication.
  - Optional username and password storage (only when `User & Password` is chosen).
- Saved connections persist across VS Code sessions in the extension’s global storage.

### Editing or removing a connection

- Right-click a connection node and choose **Edit Connection** or run `OPC UA Browser: Edit Connection`.
  - When editing, enable **Clear stored password** to remove a previously saved password.
- Use **Delete Connection** to remove the profile (you will be prompted for confirmation).
- Run `OPC UA Browser: Refresh Connections` to reload statuses if server availability has changed.

### Connection status indicators

- Icons and descriptions reflect the current state:
  - **Connected** nodes display a green indicator (`vm-connect`) and show the active reference scope.
  - **Connecting** nodes spin (`sync~spin`).
  - **Error** or **Disconnected** nodes indicate issues or offline status.
- Select **Connect** or **Disconnect** in the context menu to control the session on demand.

### Showing non-hierarchical references

- Some OPC UA servers expose important references that are not strictly hierarchical.
- Use `OPC UA Browser: Toggle Non-Hierarchical References` from the connection node’s context menu to include or hide those references for that specific server.
- The toggle state is remembered per connection until you change it again.

## Browsing the Address Space

- Expand the connection node to view root folders discovered from `RootFolder`.
- Continue expanding child nodes to step through the address space; icons map to OPC UA node classes (Objects, Variables, Methods, and so on).
- Double-click a node or choose **Show Node Details** to inspect it in depth.
- Node tooltips include the full NodeId for quick reference.

## Node Detail Panel

- The node detail panel is launched with `OPC UA Browser: Show Node Details`, from the tree’s default double-click action, or from the context menu.
- Features:
  - Displays attributes such as value, data type, access levels, and timestamps.
  - Lists forward and inverse references grouped by type.
  - Refreshes automatically every second while the panel is open; manual refresh is not required.
- If the connection drops, the panel shows an inline error until the session is restored.

## Monitoring Data with Data View

- Track frequently used nodes by selecting **Add Node to Data View** in the tree or running `OPC UA Browser: Add Node to Data View`.
- Open the Data View from the tree toolbar, the context menu, or by running `OPC UA Browser: Open Data View`.
- The Data View panel provides:
  - A live table that refreshes every two seconds while the panel remains open.
  - Optional columns (Value, Data Type, Status, Source Timestamp, Server Timestamp, Connection, NodeId, Description, Node Class). Use **Configure Columns** to adjust the layout.
  - Per-row actions to remove an entry and a **Clear All** action to reset the list.
  - Status messaging showing when the last refresh succeeded or failed.
- Data View entries persist across VS Code restarts. They resume updates as soon as the related connection is online again.

## Searching for Nodes

- Run `OPC UA Browser: Search Nodes` to search across all connected servers, or choose **Search Nodes in Connection** from a specific server’s context menu.
- The Search panel supports:
  - Text searches against display names and browse names.
  - Explicit NodeId lookups using patterns like `ns=2;s=Machine/1/Temperature`. Input is normalized automatically.
  - Scope selection (all connected servers or a single connection).
  - Progress indicators per connection and cancellation when needed.
- Double-click a result (or use the **Reveal in Tree** action) to expand the corresponding nodes in the tree and open the node detail panel automatically.

## Exporting to Excel

- Right-click any node and choose **Export Node to Excel** (or run `OPC UA Browser: Export Node to Excel`).
- Choose an output path and decide whether to export only the selected node or include all children recursively (depth-limited to prevent runaway traversals).
- Only variable-class nodes are included in the export. If none are found, the extension reports the issue before writing a file.
- The generated workbook contains:
  - A sheet named after the exported root node (truncated to Excel’s 31-character limit) with columns for NodeId, Display Name, Browse Name, and Data Type.
  - A `Summary` sheet listing total variable nodes, root metadata, and the export timestamp.

## Commands

| Command | Description |
| --- | --- |
| `OPC UA Browser: Add Connection` | Open the connection editor to create a new server profile. |
| `OPC UA Browser: Refresh Connections` | Refresh connection statuses and reload the tree. |
| `OPC UA Browser: Connect` | Establish a session to the selected server. |
| `OPC UA Browser: Disconnect` | Close the active session for the selected server. |
| `OPC UA Browser: Toggle Non-Hierarchical References` | Switch between hierarchical-only browsing and showing all references. |
| `OPC UA Browser: Edit Connection` | Modify an existing connection configuration. |
| `OPC UA Browser: Delete Connection` | Remove a stored connection profile. |
| `OPC UA Browser: Show Node Details` | Open the node detail panel for the selected item. |
| `OPC UA Browser: Add Node to Data View` | Add the node to the live monitoring grid. |
| `OPC UA Browser: Open Data View` | Display or focus the Data View panel. |
| `OPC UA Browser: Export Node to Excel` | Export variable nodes to an Excel workbook. |
| `OPC UA Browser: Search Nodes` | Search the address space of connected servers. |
| `OPC UA Browser: Search Nodes in Connection` | Search within a single selected server. |

## Data Persistence and Security

- Connection profiles and Data View selections are stored in VS Code’s global state for the current user. Remove entries via the UI if you no longer need them.
- Saved passwords are kept in the same storage area and are not encrypted beyond VS Code’s own storage mechanism. Avoid storing credentials on shared machines and use the **Clear stored password** option when editing a connection to remove them.
- Excel exports are written only to paths you select during the export workflow; the extension does not transmit data outside your workstation.

## Troubleshooting

- **Unable to connect**: Confirm the endpoint URL, verify firewall and network access, and ensure the selected security mode/policy pair matches the server configuration. Use **Discover Endpoints** to validate available options.
- **Authentication fails**: Re-enter credentials, check server-side permissions, or switch to anonymous access if supported.
- **Tree shows no children**: Make sure the connection is in the **Connected** state and toggle non-hierarchical references if the server uses non-standard relationships.
- **Node Detail panel reports not connected**: Reconnect the server or close and reopen the panel after restoring the session.
- **Data View rows display errors**: Ensure the target connection remains connected. Removing and re-adding the node can help if the server has changed namespace indexes.
- **Search returns no results**: Expand your search scope, confirm the connection is online, or search by full NodeId when the display name is not unique.

## Support

Please report bugs or submit feature requests by opening an issue in the project repository (for example `https://github.com/runbrick/opc-client/issues`). Include VS Code version, extension version, and relevant log details to help with diagnosis.

## License

OPC UA Browser is distributed under the MIT License. See `LICENSE` for the full text.
