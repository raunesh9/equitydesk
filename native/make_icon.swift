import Cocoa
let directory = CommandLine.arguments[1]
for (name, size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = CGFloat(size) / 1024
    let transform = NSAffineTransform(); transform.scale(by: scale); transform.concat()
    NSColor(calibratedRed: 0.03, green: 0.16, blue: 0.10, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 50,y:50,width:924,height:924),xRadius:205,yRadius:205).fill()
    let line = NSBezierPath()
    line.move(to:NSPoint(x:235,y:345));line.line(to:NSPoint(x:430,y:555));line.line(to:NSPoint(x:560,y:440));line.line(to:NSPoint(x:785,y:710))
    line.lineWidth=68;line.lineCapStyle = .round;line.lineJoinStyle = .round
    NSColor(calibratedRed:0.36,green:1.0,blue:0.55,alpha:1).setStroke();line.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using:.png,properties:[:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name+".png"))
}
