import AVFoundation
import Vision

/// One tracked frame, expressed in *camera image space* (x to the right of the
/// unmirrored camera image, y down). Mirroring is applied later by the app.
struct FaceFrame {
    var yaw = 0.0        // -1…1, + = nose toward image right
    var pitch = 0.0      // -1…1, + = looking up
    var roll = 0.0       // radians, + = clockwise in a y-down image
    var eyeL = 1.0       // openness 0…1 of the eye on the image-left side
    var eyeR = 1.0
    var browL = 0.0      // -1…1 raise
    var browR = 0.0
    var mouthOpen = 0.0  // 0…1
    var smile = 0.0      // -1…1
    var gazeX = 0.0      // -1…1
    var gazeY = 0.0
    var posX = 0.0       // -1…1 face position in the camera frame
    var posY = 0.0
    var lean = 0.0       // + = closer to the camera than usual
    var debug: [String: Double] = [:]
}

/// Slowly adapting baseline: averages the first samples, then follows with a long time constant.
private struct Baseline {
    var value = 0.0
    var count = 0
    let warmup: Int
    let alpha: Double
    init(warmup: Int = 30, alpha: Double = 0.002) { self.warmup = warmup; self.alpha = alpha }
    mutating func update(_ x: Double) {
        if count < warmup {
            count += 1
            value += (x - value) / Double(count)
        } else {
            value += (x - value) * alpha
        }
    }
    var ready: Bool { count >= 5 }
}

/// One-Euro filter: low jitter when still, low lag when moving.
private struct OneEuro {
    var minCutoff: Double
    var beta: Double
    var dCutoff = 1.0
    private var x: Double?
    private var dx = 0.0
    private var lastT: Double?
    init(minCutoff: Double = 1.2, beta: Double = 0.02) { self.minCutoff = minCutoff; self.beta = beta }
    private func alpha(_ cutoff: Double, _ dt: Double) -> Double {
        let tau = 1.0 / (2 * .pi * cutoff)
        return 1.0 / (1.0 + tau / dt)
    }
    mutating func filter(_ value: Double, t: Double) -> Double {
        guard let prev = x, let lt = lastT, t > lt else { x = value; lastT = t; return value }
        let dt = max(t - lt, 1e-3)
        let a_d = alpha(dCutoff, dt)
        dx = a_d * ((value - prev) / dt) + (1 - a_d) * dx
        let cutoff = minCutoff + beta * abs(dx)
        let a = alpha(cutoff, dt)
        let out = a * value + (1 - a) * prev
        x = out; lastT = t
        return out
    }
    mutating func reset() { x = nil; lastT = nil; dx = 0 }
}

final class FaceTracker: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    /// Called on the main queue. `nil` means no face in view.
    var onFrame: ((FaceFrame?) -> Void)?
    var onError: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "minime.facetracker", qos: .userInteractive)
    private var configured = false
    private(set) var isRunning = false
    private var lastProcessed = 0.0
    private let minInterval = 1.0 / 24.0
    private let seq = VNSequenceRequestHandler()

    // Baselines (neutral face), measured in inter-ocular-distance units.
    private var eyeOpenBase = Baseline(warmup: 20, alpha: 0.01)
    private var browBaseL = Baseline(), browBaseR = Baseline()
    private var cornerBase = Baseline(), widthBase = Baseline()
    private var pitchBase = Baseline(warmup: 40, alpha: 0.0015)
    private var sizeBase = Baseline(warmup: 40, alpha: 0.001)
    private var missing = 0

    private var filters: [String: OneEuro] = [:]

    // MARK: control

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            queue.async { self.startOnQueue() }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                if ok { self.queue.async { self.startOnQueue() } }
                else { DispatchQueue.main.async { self.onError?("denied") } }
            }
        default:
            DispatchQueue.main.async { self.onError?("denied") }
        }
    }

    func stop() {
        queue.async {
            guard self.isRunning else { return }
            self.session.stopRunning()
            self.isRunning = false
            DispatchQueue.main.async { self.onFrame?(nil) }
        }
    }

    private func startOnQueue() {
        if !configured {
            guard configure() else { DispatchQueue.main.async { self.onError?("nocamera") }; return }
            configured = true
        }
        guard !isRunning else { return }
        session.startRunning()
        isRunning = true
    }

    private func configure() -> Bool {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .unspecified)
        guard let device = discovery.devices.first ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return false }
        session.beginConfiguration()
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        else if session.canSetSessionPreset(.medium) { session.sessionPreset = .medium }
        guard session.canAddInput(input) else { session.commitConfiguration(); return false }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { session.commitConfiguration(); return false }
        session.addOutput(output)
        session.commitConfiguration()
        return true
    }

    // MARK: capture

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        let t = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        guard t - lastProcessed >= minInterval * 0.9,
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastProcessed = t

        let request = VNDetectFaceLandmarksRequest()
        do { try seq.perform([request], on: pb, orientation: .up) } catch { return }
        let W = Double(CVPixelBufferGetWidth(pb)), H = Double(CVPixelBufferGetHeight(pb))
        let faces = (request.results ?? []).filter { $0.landmarks != nil }
        guard let face = faces.max(by: { $0.boundingBox.width < $1.boundingBox.width }),
              var frame = analyze(face, W: W, H: H) else {
            missing += 1
            if missing == 6 {   // ~¼ s without a face
                for k in filters.keys { filters[k]?.reset() }
                DispatchQueue.main.async { self.onFrame?(nil) }
            }
            return
        }
        missing = 0
        smooth(&frame, t: t)
        DispatchQueue.main.async { self.onFrame?(frame) }
    }

    // MARK: analysis

    private func analyze(_ face: VNFaceObservation, W: Double, H: Double) -> FaceFrame? {
        guard let lm = face.landmarks else { return nil }
        let size = CGSize(width: W, height: H)
        func pts(_ r: VNFaceLandmarkRegion2D?) -> [CGPoint] {
            guard let r, r.pointCount > 0 else { return [] }
            return r.pointsInImage(imageSize: size).map { CGPoint(x: $0.x, y: H - $0.y) } // y down
        }
        func centroid(_ p: [CGPoint]) -> CGPoint {
            let n = Double(max(p.count, 1))
            return CGPoint(x: p.reduce(0) { $0 + $1.x } / n, y: p.reduce(0) { $0 + $1.y } / n)
        }

        var eyeA = pts(lm.leftEye), eyeB = pts(lm.rightEye)
        guard eyeA.count >= 4, eyeB.count >= 4 else { return nil }
        if centroid(eyeA).x > centroid(eyeB).x { swap(&eyeA, &eyeB) }       // A = image-left
        var browA = pts(lm.leftEyebrow), browB = pts(lm.rightEyebrow)
        if !browA.isEmpty, !browB.isEmpty, centroid(browA).x > centroid(browB).x { swap(&browA, &browB) }
        var pupils = pts(lm.leftPupil) + pts(lm.rightPupil)
        pupils.sort { $0.x < $1.x }

        let cl = centroid(eyeA), cr = centroid(eyeB)
        let dx = cr.x - cl.x, dy = cr.y - cl.y
        let D = max(hypot(dx, dy), 1)
        let roll = atan2(dy, dx)
        let mid = CGPoint(x: (cl.x + cr.x) / 2, y: (cl.y + cr.y) / 2)
        let c = cos(-roll), s = sin(-roll)
        func norm(_ p: CGPoint) -> CGPoint {
            let x = p.x - mid.x, y = p.y - mid.y
            return CGPoint(x: (x * c - y * s) / D, y: (x * s + y * c) / D)
        }
        func box(_ p: [CGPoint]) -> (minX: Double, maxX: Double, minY: Double, maxY: Double) {
            let n = p.map(norm)
            let xs = n.map { Double($0.x) }, ys = n.map { Double($0.y) }
            return (xs.min() ?? 0, xs.max() ?? 0, ys.min() ?? 0, ys.max() ?? 0)
        }

        var f = FaceFrame()
        f.roll = roll

        // Eyes: height / width of the contour, relative to an adaptive "open" baseline.
        let ba = box(eyeA), bb = box(eyeB)
        let ra = (ba.maxY - ba.minY) / max(ba.maxX - ba.minX, 1e-3)
        let rb = (bb.maxY - bb.minY) / max(bb.maxX - bb.minX, 1e-3)
        let rMax = max(ra, rb)
        if !eyeOpenBase.ready || rMax > eyeOpenBase.value * 0.8 { eyeOpenBase.update(rMax) }
        let open = max(eyeOpenBase.value, 0.05)
        func openness(_ r: Double) -> Double { clamp((r - open * 0.5) / (open * 0.45), 0, 1) }
        f.eyeL = openness(ra); f.eyeR = openness(rb)

        // Gaze from pupils relative to the eye contour.
        if pupils.count >= 2 {
            let pa = norm(pupils[0]), pb = norm(pupils[1])
            let ca = norm(cl), cb = norm(cr)
            let wa = max(ba.maxX - ba.minX, 0.05), wb = max(bb.maxX - bb.minX, 0.05)
            let gx = ((pa.x - ca.x) / (wa / 2) + (pb.x - cb.x) / (wb / 2)) / 2
            let gy = ((pa.y - ca.y) / (wa / 2) + (pb.y - cb.y) / (wb / 2)) / 2
            f.gazeX = clamp(gx * 1.6, -1, 1)
            f.gazeY = clamp(gy * 2.0, -1, 1)
        }

        // Brows: vertical distance brow ↔ eye.
        if !browA.isEmpty, !browB.isEmpty {
            let da = norm(centroid(eyeA)).y - norm(centroid(browA)).y
            let db = norm(centroid(eyeB)).y - norm(centroid(browB)).y
            browBaseL.update(da); browBaseR.update(db)
            f.browL = clamp((da - browBaseL.value) / 0.07, -1, 1)
            f.browR = clamp((db - browBaseR.value) / 0.07, -1, 1)
            f.debug["browRaw"] = (da + db) / 2
        }

        // Mouth.
        let inner = pts(lm.innerLips), outer = pts(lm.outerLips), nose = pts(lm.nose)
        if inner.count >= 4, outer.count >= 4, !nose.isEmpty {
            let ib = box(inner), ob = box(outer), nb = box(nose)
            let innerH = ib.maxY - ib.minY
            f.mouthOpen = clamp((innerH - 0.05) / 0.32, 0, 1)
            let on = outer.map(norm)
            let left = on.min { $0.x < $1.x }!, right = on.max { $0.x < $1.x }!
            let cornerToNose = (left.y + right.y) / 2 - nb.maxY     // smaller when smiling
            let width = right.x - left.x
            cornerBase.update(cornerToNose); widthBase.update(width)
            var smile = (cornerBase.value - cornerToNose) * 7 + (width - widthBase.value) * 3.5
            smile -= f.mouthOpen * 0.25                            // jaw drop reads as a fake smile
            f.smile = clamp(smile, -1, 1)
            f.debug["innerH"] = innerH
            f.debug["corner"] = cornerToNose
            f.debug["mouthW"] = width

            // Pitch: where the nose tip sits between eye line (0) and upper lip.
            let ratio = nb.maxY / max(ob.minY, 0.2)
            pitchBase.update(ratio)
            f.pitch = clamp(-(ratio - pitchBase.value) * 6, -1, 1)
            f.debug["pitchRaw"] = ratio
        }

        // Yaw: nose position between the jaw edges.
        let contour = pts(lm.faceContour)
        if contour.count >= 5, !nose.isEmpty {
            let cb = box(contour)
            let noseX = norm(centroid(pts(lm.noseCrest).isEmpty ? nose : pts(lm.noseCrest))).x
            let rel = (noseX - cb.minX) / max(cb.maxX - cb.minX, 0.1)
            f.yaw = clamp((rel - 0.5) * 3.2, -1, 1)
            f.debug["yawRaw"] = rel
        }
        if let vy = face.yaw?.doubleValue { f.debug["visionYaw"] = vy }
        if let vp = face.pitch?.doubleValue { f.debug["visionPitch"] = vp }

        // Position & distance.
        let bbox = face.boundingBox
        f.posX = clamp((bbox.midX - 0.5) * 2.2, -1, 1)
        f.posY = clamp(((1 - bbox.midY) - 0.5) * 2.2, -1, 1)
        sizeBase.update(bbox.height)
        f.lean = clamp(bbox.height / max(sizeBase.value, 0.05) - 1, -0.5, 0.5)
        return f
    }

    private func smooth(_ f: inout FaceFrame, t: Double) {
        func run(_ key: String, _ v: inout Double, minCutoff: Double = 1.2, beta: Double = 0.03) {
            if filters[key] == nil { filters[key] = OneEuro(minCutoff: minCutoff, beta: beta) }
            v = filters[key]!.filter(v, t: t)
        }
        run("yaw", &f.yaw); run("pitch", &f.pitch); run("roll", &f.roll)
        run("eyeL", &f.eyeL, minCutoff: 4, beta: 0.4); run("eyeR", &f.eyeR, minCutoff: 4, beta: 0.4)
        run("browL", &f.browL, minCutoff: 1.5); run("browR", &f.browR, minCutoff: 1.5)
        run("mouth", &f.mouthOpen, minCutoff: 3, beta: 0.3); run("smile", &f.smile, minCutoff: 1.5)
        run("gx", &f.gazeX, minCutoff: 1); run("gy", &f.gazeY, minCutoff: 1)
        run("px", &f.posX, minCutoff: 0.8); run("py", &f.posY, minCutoff: 0.8)
        run("lean", &f.lean, minCutoff: 0.6)
    }
}

@inline(__always) func clamp(_ x: Double, _ lo: Double, _ hi: Double) -> Double { min(max(x, lo), hi) }
