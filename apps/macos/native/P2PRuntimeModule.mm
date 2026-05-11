// P2PRuntimeModule.mm — NSTask-backed IPC bridge for @workspace/p2p-runtime.
//
// Architecture:
//   JS SpawnedRuntime  →  MacOSTransport (TS)  →  this module (Obj-C++)
//                                                       ↕  NSPipe stdio
//                                                  Node child (child-bin.ts)
//
// Thread model:
//   - spawn/close run on the RCTModuleData dispatch queue (serial).
//   - stdout is read on a dedicated background thread (NSTask's stdout pipe
//     fileHandleForReading via readabilityHandler).
//   - sendEventWithName: is thread-safe — RCTEventEmitter dispatches to the
//     main queue internally.

#import "P2PRuntimeModule.h"

#import <React/RCTLog.h>

@implementation P2PRuntimeModule {
    NSTask   *_task;
    NSPipe   *_inPipe;   // JS → child (stdin)
    NSPipe   *_outPipe;  // child → JS (stdout)
    NSMutableString *_lineBuffer;  // incomplete line accumulator
    BOOL     _hasListeners;
}

// ---------------------------------------------------------------------------
// RCTBridgeModule
// ---------------------------------------------------------------------------

RCT_EXPORT_MODULE(P2PRuntime)

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents {
    return @[@"p2pLine", @"p2pExit"];
}

- (void)startObserving { _hasListeners = YES; }
- (void)stopObserving  { _hasListeners = NO;  }

// ---------------------------------------------------------------------------
// JS-callable methods
// ---------------------------------------------------------------------------

/// Spawn the Node child process.
RCT_EXPORT_METHOD(spawn:(NSString *)nodeBin
                  scriptPath:(NSString *)scriptPath
                  storage:(nullable NSString *)storage
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    if (_task && _task.isRunning) {
        reject(@"P2P_ALREADY_RUNNING", @"Child process is already running", nil);
        return;
    }

    _lineBuffer = [NSMutableString string];
    _inPipe  = [NSPipe pipe];
    _outPipe = [NSPipe pipe];

    _task = [[NSTask alloc] init];
    _task.executableURL = [NSURL fileURLWithPath:nodeBin];
    _task.arguments = @[
        @"--experimental-strip-types",
        @"--no-warnings",
        scriptPath,
    ];
    _task.standardInput  = _inPipe;
    _task.standardOutput = _outPipe;
    // stderr inherits so child crash output appears in the macOS Console / Xcode.
    _task.standardError  = [NSFileHandle fileHandleWithStandardError];

    // Propagate storage path via environment variable so we don't need an
    // extra init-round-trip just for it. Child-bin reads P2P_STORAGE_PATH.
    NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
    if (storage) env[@"P2P_STORAGE_PATH"] = storage;
    _task.environment = env;

    // --- stdout reader -------------------------------------------------
    __weak typeof(self) weakSelf = self;
    _outPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = handle.availableData;
        if (!data.length) return; // EOF
        NSString *chunk = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (!chunk) return;
        [weakSelf feedChunk:chunk];
    };

    // --- exit handler --------------------------------------------------
    _task.terminationHandler = ^(NSTask *t) {
        __strong typeof(weakSelf) self = weakSelf;
        if (!self) return;
        // Flush any remaining buffered output before signalling exit.
        NSData *remaining = [self->_outPipe.fileHandleForReading readDataToEndOfFile];
        if (remaining.length) {
            NSString *tail = [[NSString alloc] initWithData:remaining encoding:NSUTF8StringEncoding];
            if (tail) [self feedChunk:tail];
        }
        self->_outPipe.fileHandleForReading.readabilityHandler = nil;
        if (self->_hasListeners) {
            [self sendEventWithName:@"p2pExit"
                              body:@{@"code": @(t.terminationStatus)}];
        }
    };

    NSError *err = nil;
    if (![_task launchAndReturnError:&err]) {
        reject(@"P2P_SPAWN_FAILED", err.localizedDescription, err);
        return;
    }

    resolve(nil);
}

/// Write a complete JSON-RPC line (already newline-terminated) to child stdin.
RCT_EXPORT_METHOD(send:(NSString *)line)
{
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    if (data) {
        [_inPipe.fileHandleForWriting writeData:data];
    }
}

/// Terminate the child and wait for it to exit.
RCT_EXPORT_METHOD(close:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
    if (!_task || !_task.isRunning) {
        resolve(nil);
        return;
    }
    // Close stdin — child-bin.ts exits cleanly on stdin EOF.
    [_inPipe.fileHandleForWriting closeFile];
    // Give the child 2 s to exit gracefully before forcing termination.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC),
                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        if (self->_task.isRunning) [self->_task terminate];
    });
    resolve(nil);
}

// ---------------------------------------------------------------------------
// Private — stdout line splitting (mirrors ipc/framing.ts LineDecoder)
// ---------------------------------------------------------------------------

- (void)feedChunk:(NSString *)chunk {
    [_lineBuffer appendString:chunk];
    NSArray<NSString *> *parts = [_lineBuffer componentsSeparatedByString:@"\n"];
    // Everything except the last element is a complete line.
    for (NSUInteger i = 0; i < parts.count - 1; i++) {
        NSString *line = parts[i];
        if (line.length == 0) continue;
        if (_hasListeners) {
            [self sendEventWithName:@"p2pLine" body:@{@"line": line}];
        }
    }
    // Keep the incomplete tail.
    _lineBuffer = [parts.lastObject mutableCopy] ?: [NSMutableString string];
}

@end
