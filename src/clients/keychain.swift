import Foundation
import Security

// All operation inputs, including credential values, arrive through stdin.
// No diagnostics or credential-bearing OSStatus descriptions are emitted.
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count < 65536,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let service = request["service"] as? String,
          let account = request["account"] as? String,
          let action = request["action"] as? String else { exit(1) }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account]
    var output: Any = NSNull()
    switch action {
    case "get":
        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            output = try JSONSerialization.jsonObject(with: data)
        } else if status != errSecItemNotFound { exit(1) }
    case "set":
        guard let value = request["value"] else { exit(1) }
        let data = try JSONSerialization.data(withJSONObject: value)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { exit(1) }
        } else if update != errSecSuccess { exit(1) }
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { exit(1) }
    default: exit(1)
    }
    let data = try JSONSerialization.data(withJSONObject: output, options: [.fragmentsAllowed])
    FileHandle.standardOutput.write(data)
} catch { exit(1) }
