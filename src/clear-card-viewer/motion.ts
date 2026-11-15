export const SPRING_EPSILON = 0.0001;

export type SpringValue = {
  current: number;
  target: number;
  velocity: number;
};

export function stepSpringAxis(
  current: number,
  target: number,
  velocity: number,
  deltaSeconds: number,
  stiffness: number,
  damping: number,
): { current: number; velocity: number } {
  const acceleration = (target - current) * stiffness - velocity * damping;
  const nextVelocity = velocity + acceleration * deltaSeconds;
  return {
    current: current + nextVelocity * deltaSeconds,
    velocity: nextVelocity,
  };
}

export function stepSpringValue(spring: SpringValue, deltaSeconds: number, stiffness: number, damping: number) {
  const stepped = stepSpringAxis(spring.current, spring.target, spring.velocity, deltaSeconds, stiffness, damping);
  spring.current = stepped.current;
  spring.velocity = stepped.velocity;
}

export function isSpringValueSettled(spring: SpringValue) {
  return (
    Math.abs(spring.target - spring.current) <= SPRING_EPSILON &&
    Math.abs(spring.velocity) <= SPRING_EPSILON
  );
}

export function snapSpringValue(spring: SpringValue) {
  spring.current = spring.target;
  spring.velocity = 0;
}
