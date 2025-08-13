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

## Usage
- Open the Etcd view from the Activity Bar
- Click "+" to add a connection (e.g., `127.0.0.1:2379`)
- Expand a connection to load all keys and values
- Use the tree view and flattening buttons to customize the display for each connection

## Requirements
- etcd v3 endpoint(s)
- If authentication is enabled, provide username/password in the form

## Known Limitations
- Keys are loaded in full; for very large datasets, consider adding prefixes in the future

## Release Notes
### 1.1.2
- Added connection timeout settings
- Implemented hierarchical tree expansion
- Added flattening tree structure feature
- Introduced tree view and flattening buttons at the connection level
- Enhanced tooltips and overall UI/UX

### 0.1.0
- Renamed and rebranded to Etcd Compass by Sportscanner

## License
This project is licensed under the terms of the MIT open source license. Please refer to MIT for the full terms.