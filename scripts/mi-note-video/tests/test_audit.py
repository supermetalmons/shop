import ast
from decimal import Decimal, ROUND_HALF_UP
import json
import math
from pathlib import Path
import shutil
import subprocess
import unittest


HERE = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((HERE / 'contract.json').read_text())
SOURCE = ast.parse((HERE / 'audit.py').read_text())


class AuditContractTests(unittest.TestCase):
    def test_independent_motion_predictions_match_all_approved_renderer_poses(self):
        function = next(node for node in SOURCE.body if isinstance(node, ast.FunctionDef) and node.name == 'expected_motion')
        namespace = {'math': math, 'CONTRACT': CONTRACT, 'Decimal': Decimal, 'ROUND_HALF_UP': ROUND_HALF_UP}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(HERE / 'audit.py'), 'exec'), namespace)
        program = '''
import { tsImport } from 'tsx/esm/api';
import { pathToFileURL } from 'node:url';
const {computeRecordingFrameStyle} = await tsImport(process.argv[1], pathToFileURL(process.cwd()+'/audit-test.mjs').href);
const fields={pointerX:'--pointer-x',pointerY:'--pointer-y',backgroundX:'--background-x',backgroundY:'--background-y',pointerFromCenter:'--pointer-from-center',rotateX:'--rotate-x',rotateY:'--rotate-y',opacity:'--card-opacity',scale:'--card-scale',translateX:'--translate-x',translateY:'--translate-y'};
const result={};
for(const motion of ['original','vertical-swing','breathing-swing']) result[motion]=Array.from({length:276},(_,frame)=>{
const style=Object.fromEntries(computeRecordingFrameStyle(frame,276,{effectOpacity:.99,tilt:true,lightPath:'orbit',...(motion==='original'?{}:{motionLoop:motion})}).split(';').map(value=>value.split(':')));
return Object.fromEntries(Object.entries(fields).map(([field,variable])=>[field,Number.parseFloat(style[variable])]));
});
console.log(JSON.stringify(result));
'''
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for source/auditor pose parity tests')
        result = subprocess.run([node, '--input-type=module', '-e', program, str(HERE / 'motion.ts')], check=True, capture_output=True, text=True)
        renderer = json.loads(result.stdout)
        for motion in CONTRACT['motions']:
            for frame, values in enumerate(renderer[motion]):
                expected = namespace['expected_motion'](frame, motion)
                for key, value in values.items():
                    self.assertLess(abs(value - expected[key]), 1e-9, f'{motion}:{frame}:{key}')

    def test_fidelity_thresholds_are_the_approved_values(self):
        assignment = next(node for node in SOURCE.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'THRESHOLDS' for target in node.targets))
        self.assertEqual(ast.literal_eval(assignment.value), {'wholeImageMAE': 3.0, 'cardInteriorMAE': 6.0,
            'absoluteMeanSignedRGB': 1.5, 'edgeEnergyRetention': .85, 'fineDetailEnergyRetention': .75, 'blackBorderMean': .5})


if __name__ == '__main__':
    unittest.main()
