import Darwin
import Foundation

final class LocalControlServer {
  private let path: String
  private let handler: ([String: Any]) -> [String: Any]
  private let lock = NSLock()
  private var listener: Int32 = -1
  private var running = false

  init(path: String, handler: @escaping ([String: Any]) -> [String: Any]) {
    self.path = path
    self.handler = handler
  }

  func start() throws {
    let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
    try FileManager.default.createDirectory(
      atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard chmod(directory, 0o700) == 0 else { throw Self.error("无法保护本地控制目录") }
    if Self.pathExists(path) {
      guard Self.isOwnedSocket(path) else { throw Self.error("控制路径已被非 socket 文件占用") }
      if Self.canConnect(path) { throw Self.error("本地控制服务已运行") }
      guard unlink(path) == 0 else { throw Self.error("无法清理失效的控制 socket") }
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Self.error("无法创建本地控制 socket") }
    do {
      let address = try Self.address(path)
      let bindResult = withUnsafePointer(to: address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
      }
      guard bindResult == 0 else { throw Self.error("无法绑定本地控制 socket") }
      guard chmod(path, 0o600) == 0 else { throw Self.error("无法限制本地控制 socket 权限") }
      guard listen(fd, 8) == 0 else { throw Self.error("无法监听本地控制 socket") }
      lock.lock()
      listener = fd
      running = true
      lock.unlock()
      DispatchQueue.global(qos: .utility).async { [weak self] in self?.acceptLoop(fd) }
    } catch {
      close(fd)
      throw error
    }
  }

  func stop() {
    lock.lock()
    let fd = listener
    listener = -1
    running = false
    lock.unlock()
    if fd >= 0 {
      shutdown(fd, SHUT_RDWR)
      close(fd)
    }
    if Self.isOwnedSocket(path) { _ = unlink(path) }
  }

  deinit { stop() }

  private func acceptLoop(_ fd: Int32) {
    while isRunning {
      let client = Darwin.accept(fd, nil, nil)
      if client < 0 {
        if errno == EINTR { continue }
        if isRunning { Thread.sleep(forTimeInterval: 0.05) }
        continue
      }
      DispatchQueue.global(qos: .utility).async { [weak self] in self?.handle(client) }
    }
  }

  private var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  private func handle(_ client: Int32) {
    defer { close(client) }
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    var noSigpipe: Int32 = 1
    _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    _ = setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    _ = setsockopt(
      client, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
    var input = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    var requestData: Data?
    while input.count <= 4096 {
      let count = buffer.withUnsafeMutableBytes { raw in
        Darwin.read(client, raw.baseAddress!, raw.count)
      }
      if count <= 0 { return }
      if let newline = buffer[..<count].firstIndex(of: 10) {
        input.append(contentsOf: buffer[..<newline])
        requestData = input
        break
      }
      input.append(contentsOf: buffer[..<count])
    }
    guard let requestData = requestData,
      let request = try? JSONSerialization.jsonObject(with: requestData) as? [String: Any]
    else {
      send(["ok": false, "error": "invalid request"], to: client)
      return
    }
    send(handler(request), to: client)
  }

  private func send(_ response: [String: Any], to fd: Int32) {
    guard var data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    else { return }
    data.append(10)
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var offset = 0
      while offset < data.count {
        let sent = Darwin.send(fd, base.advanced(by: offset), data.count - offset, 0)
        if sent < 0 {
          if errno == EINTR { continue }
          return
        }
        if sent == 0 { return }
        offset += sent
      }
    }
  }

  private static func pathExists(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0
  }
  private static func isOwnedSocket(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFSOCK && info.st_uid == getuid()
  }
  private static func canConnect(_ path: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    guard let address = try? address(path) else { return false }
    return withUnsafePointer(to: address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
      }
    }
  }
  private static func address(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= capacity else { throw error("控制 socket 路径过长") }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { destination in
        bytes.withUnsafeBufferPointer { source in
          _ = memcpy(destination, source.baseAddress!, bytes.count)
        }
      }
    }
    return address
  }
  private static func error(_ message: String) -> NSError {
    NSError(domain: "NOIDControl", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
