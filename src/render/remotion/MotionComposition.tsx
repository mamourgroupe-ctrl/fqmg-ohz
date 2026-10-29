import { useMemo, type CSSProperties } from "react";
import { AbsoluteFill, Audio, Img, Sequence, Video, useCurrentFrame } from "remotion";
import {
  MotionSpecificationSchema,
  type AssetSpec,
  type MotionLayer,
  type MotionSpecification,
} from "@/motion/schemas/motion-specification";
import { audioTrackVolumeAt } from "@/render/remotion/audio-mix";

export interface MotionCompositionProps {
  spec: MotionSpecification;
}

type NumericMotionProperty = "xPercent" | "yPercent" | "scale" | "rotation" | "opacity" | "fontSize";

function ease(progress: number, easing: "linear" | "ease-in" | "ease-out" | "ease-in-out"): number {
  const clamped = Math.max(0, Math.min(1, progress));
  if (easing === "ease-in") return clamped * clamped;
  if (easing === "ease-out") return 1 - (1 - clamped) ** 2;
  if (easing === "ease-in-out") {
    return clamped < 0.5
      ? 2 * clamped * clamped
      : 1 - ((-2 * clamped + 2) ** 2) / 2;
  }
  return clamped;
}

function getNumericValue(
  layer: MotionLayer,
  property: NumericMotionProperty,
  frame: number,
  fallback: number,
): number {
  const keyframes = layer.keyframes
    .filter((keyframe) => keyframe.property === property && typeof keyframe.value === "number")
    .sort((left, right) => left.frame - right.frame);

  if (keyframes.length === 0) return fallback;
  if (frame <= keyframes[0].frame) return keyframes[0].value as number;
  if (frame >= keyframes[keyframes.length - 1].frame) return keyframes[keyframes.length - 1].value as number;

  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const start = keyframes[index];
    const end = keyframes[index + 1];
    if (frame >= start.frame && frame <= end.frame) {
      const rawProgress = (frame - start.frame) / (end.frame - start.frame);
      const progress = ease(rawProgress, end.easing);
      const startValue = start.value as number;
      const endValue = end.value as number;
      return startValue + (endValue - startValue) * progress;
    }
  }

  return fallback;
}

function getTextValue(layer: MotionLayer, frame: number, fallback: string): string {
  const activeKeyframe = layer.keyframes
    .filter((keyframe) => keyframe.property === "text" && typeof keyframe.value === "string" && keyframe.frame <= frame)
    .sort((left, right) => left.frame - right.frame)
    .at(-1);
  return typeof activeKeyframe?.value === "string" ? activeKeyframe.value : fallback;
}

function resolveSource(assets: AssetSpec[], assetId: string): string | null {
  const asset = assets.find((candidate) => candidate.id === assetId);
  if (!asset || asset.source.startsWith("asset://")) return null;
  return asset.source;
}

function LayerView({ layer, assets }: { layer: MotionLayer; assets: AssetSpec[] }) {
  const frame = useCurrentFrame();
  const xPercent = getNumericValue(layer, "xPercent", frame, layer.layout.xPercent);
  const yPercent = getNumericValue(layer, "yPercent", frame, layer.layout.yPercent);
  const scale = getNumericValue(layer, "scale", frame, 1);
  const rotation = getNumericValue(layer, "rotation", frame, 0);
  const opacity = layer.opacity * getNumericValue(layer, "opacity", frame, 1);
  const commonStyle: CSSProperties = {
    position: "absolute",
    left: `${xPercent}%`,
    top: `${yPercent}%`,
    width: `${layer.layout.widthPercent}%`,
    height: `${layer.layout.heightPercent}%`,
    opacity,
    transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
  };

  if (layer.type === "text") {
    const fontSize = getNumericValue(layer, "fontSize", frame, layer.style.fontSize);
    const content = getTextValue(layer, frame, layer.content);
    const justifyContent =
      layer.style.alignment === "left"
        ? "flex-start"
        : layer.style.alignment === "right"
          ? "flex-end"
          : "center";

    return (
      <div
        dir={layer.style.direction}
        style={{
          ...commonStyle,
          display: "flex",
          alignItems: "center",
          justifyContent,
          boxSizing: "border-box",
          padding: "0.2em 0.35em",
          borderRadius: layer.style.backgroundColor ? 16 : 0,
          backgroundColor: layer.style.backgroundColor,
          color: layer.style.color,
          fontFamily: layer.style.fontFamily,
          fontSize,
          fontWeight: layer.style.weight,
          lineHeight: 1.2,
          textAlign: layer.style.alignment,
          direction: layer.style.direction === "rtl" ? "rtl" : "ltr",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {content}
      </div>
    );
  }

  if (layer.type === "image") {
    const source = resolveSource(assets, layer.assetId);
    if (!source) return <div style={{ ...commonStyle, backgroundColor: "#344054", border: "1px dashed #98A2B3" }} />;
    return <Img src={source} alt={layer.alt} style={{ ...commonStyle, objectFit: layer.fit }} />;
  }

  if (layer.type === "video") {
    const source = resolveSource(assets, layer.assetId);
    if (!source) return <div style={{ ...commonStyle, backgroundColor: "#344054", border: "1px dashed #98A2B3" }} />;
    return <Video src={source} muted={layer.muted} style={{ ...commonStyle, objectFit: layer.fit }} />;
  }

  const isCircle = layer.shape === "circle";
  const isLine = layer.shape === "line";
  return (
    <div
      style={{
        ...commonStyle,
        height: isLine ? `${Math.max(layer.strokeWidth, 2)}px` : commonStyle.height,
        backgroundColor: isLine ? layer.strokeColor ?? layer.fillColor : layer.fillColor,
        border: layer.strokeWidth > 0 ? `${layer.strokeWidth}px solid ${layer.strokeColor ?? layer.fillColor}` : undefined,
        borderRadius: isCircle ? "50%" : layer.cornerRadius,
      }}
    />
  );
}

function SceneView({ scene, assets }: { scene: MotionSpecification["scenes"][number]; assets: AssetSpec[] }) {
  const frame = useCurrentFrame();
  const transition = scene.transition;
  const transitionDuration = transition?.durationInFrames ?? 0;
  const progress = transitionDuration > 0 ? Math.max(0, Math.min(1, frame / transitionDuration)) : 1;

  let transitionStyle: CSSProperties = {};
  if (transition?.type === "fade") transitionStyle = { opacity: progress };
  if (transition?.type === "slide") {
    transitionStyle = { opacity: progress, transform: `translate3d(0, ${(1 - progress) * 5}%, 0)` };
  }
  if (transition?.type === "wipe") {
    transitionStyle = { clipPath: `inset(0 ${100 - progress * 100}% 0 0)` };
  }

  return (
    <AbsoluteFill style={transitionStyle}>
      {scene.layers.map((layer) => (
        <Sequence
          key={layer.id}
          from={layer.startFrame}
          durationInFrames={layer.durationInFrames}
          layout="none"
        >
          <LayerView layer={layer} assets={assets} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

/**
 * Phase-7 audio mixing: tracks live on the ABSOLUTE composition timeline
 * (unlike scene sequences) and follow the same source convention as
 * <Img>/<Video> — the raw asset.source resolved against the serve origin.
 * A track referencing a missing or unresolved asset fails the render
 * loudly instead of rendering a silent video.
 */
function AudioTracksView({ specification }: { specification: MotionSpecification }) {
  return (
    <>
      {specification.audio.tracks.map((track) => {
        const source = resolveSource(specification.assets, track.assetId);
        if (!source) {
          throw new Error(
            `Audio track "${track.id}" references a missing or unresolved asset "${track.assetId}".`,
          );
        }
        return (
          <Sequence
            key={track.id}
            from={track.startFrame}
            durationInFrames={track.durationInFrames}
            layout="none"
          >
            <Audio
              src={source}
              volume={(localFrame: number) =>
                audioTrackVolumeAt(localFrame, track, specification.audio.masterVolume)
              }
            />
          </Sequence>
        );
      })}
    </>
  );
}

export function MotionComposition({ spec }: MotionCompositionProps) {
  const parsed = useMemo(() => MotionSpecificationSchema.safeParse(spec), [spec]);
  if (!parsed.success) {
    return (
      <AbsoluteFill
        style={{ backgroundColor: "#241B1B", color: "#FFFFFF", alignItems: "center", justifyContent: "center", padding: 48 }}
      >
        <div role="alert" style={{ fontFamily: "Arial, sans-serif", fontSize: 32, textAlign: "center" }}>
          Invalid Motion Specification
        </div>
      </AbsoluteFill>
    );
  }

  const specification = parsed.data;
  return (
    <AbsoluteFill style={{ backgroundColor: specification.composition.backgroundColor }}>
      <AudioTracksView specification={specification} />
      {specification.scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationInFrames}
          layout="none"
        >
          <SceneView scene={scene} assets={specification.assets} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
