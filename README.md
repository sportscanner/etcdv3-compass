# Etcd Compass

Browse etcd clusters from the VS Code sidebar. Add connections and view all key-value pairs.

Built and maintained by Sportscanner (https://www.sportscanner.co.uk).

## Features
- Add etcd connections via a simple form
- Persist connections across sessions
- View all key-value pairs for a connection
- Refresh and delete connections
- Configure connection timeout settings
- Expand hierarchical tree structures for better navigation
- Flatten tree structures for easier viewing
- Use tree view and flattening buttons at the connection level
- Export and import connections as JSON to share them (including credentials) with others

## Usage
- Open the Etcd view from the Activity Bar
- Click "+" to add a connection (e.g., `127.0.0.1:2379`)
- Expand a connection to load all keys and values
- Use the tree view and flattening buttons to customize the display for each connection
- Use the "..." menu in the view title bar to export or import connections as JSON

## Requirements
- etcd v3 endpoint(s)
- If authentication is enabled, provide username/password in the form

## Known Limitations
- Keys are loaded in full; for very large datasets, consider adding prefixes in the future
