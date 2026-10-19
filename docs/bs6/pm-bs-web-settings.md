# Настройки веб-редактора BS (dist/Settings)

Редактор: DevExtreme Diagram (Scripts/dx-diagram.js), приложение — dist/scripts/main2.js, раскладки — dist/scripts/layouts.*.js.

## default.json

```json
{
  "module": "hierarchiclayoutconfig",
  "edgeLabeling": "GENERIC", //defines how labeling stage is performed NONE, GENERIC or INTEGRATED
  "layout": {
    "layoutMode": "INCREMENTAL", //�� ��������� ���� � ����, ����� ������������� ������ INCREMENTAL
    "fromScratchLayeringStrategy": "FROM_SKETCH", //HierarchicLayoutLayeringStrategy 
    "layoutOrientation": "TOP_TO_BOTTOM",

    "maximumDuration": 5000, //������ ������������ ������� �������. ������ �� �����

    "gridSpacing": 5, //�������� �� ����

    //������� �� �� ��� �������������� ����
    "orthogonalRouting": true, //������������� ��������� ������������� ���������� ortogonal vs polyline
    "backLoopRouting": false, //���� ��� ������ � ����������� ������
    "backLoopRoutingForSelfLoops": false, //��� ������ �� ����
    "automaticEdgeGrouping": false,

    //��������� ���������� ����� ��������� � ������
    "edgeToEdgeDistance": 15.0,
    "nodeToEdgeDistance": 15.0,
    "nodeToNodeDistance": 30.0,
    "minimumLayerDistance": 10.0,

    //������ � ��������
    "labelingEnabled": true, //����� �� ����������� ������ ����������� �������
    "considerNodeLabels": true, //����������� ���� � ������ ������� ��� ������ ������ �� � nodeLayoutDescriptor
    "integratedNodeLabeling": false, //��������� ��� ���������� ����� ��������
    "integratedEdgeLabeling": false, //��������� �� ����� ��� ������� ���. ����� ����� GenericLabeling � ��� �������� ��������

    //����������� � ������� (����� ������ ���� �� �����)
    "groupLayeringStrategy": "LAYOUT_GROUPS", //GroupLayeringStrategyOptions 
    "groupAlignmentPolicy": "TOP", //GroupAlignmentPolicy
    "recursiveGroupLayering": true, //��������� ������ ����������
    "compactGroups": false, //������ ��� ����������� �����, ������ ��� �����

    "componentLayoutEnabled": false, //��� ��� ������ ������������� ����������, ��������� ��������� ������ ���������
    "componentArrangementPolicy": "TOPMOST" //ComponentArrangementPolicy
  },
  //�������. ������������� ����� ��������� � layoutData
  "nodeLayoutDescriptor": {
    "minimumDistance": 15.0, //����������� ��������� �� �����������. �� ��������� min(layout.nodeToNodeDistance, layout.nodeToEdgeDistance)
    "minimumLayerHeight": 0, //����������� ������ ���� � �������� ��������� ��� �������
    "layerAlignment": 0.5, //������������ ������������ ����. 0.5 ��� ����������
    "gridReference": "ORIGIN", //ORIGIN=(0,0) The reference point is specified as offset to the center of the node. �� ��������� ����� ������� � �����, �������� ������ ���� ���� �������
    "portAssignment": "DEFAULT", //���� ������� ����� ����� ������ ���� ���� ����, ���� ����� ������ ���� ON_GRID, ���� ������� ON_SUBGRID
    "nodeLabelMode": "CONSIDER_FOR_DRAWING"
  },
  //�������. ������������� ����� ��������� � layoutData
  "edgeLayoutDescriptor": { //HierarchicLayoutEdgeRoutingStyle. Octilinear and curved edge routing can be enabled using a corresponding EdgeLayoutDescriptor,
    "routingStyle": {
      "type": "HierarchicLayoutEdgeRoutingStyle.ORTHOGONAL",
      "settings": {
        "curveShortcuts": false,
        "curveUTurnSymmetry": 0
      }
    },
    "minimumFirstSegmentLength": 10.0,
    "minimumLastSegmentLength": 15.0,
    "minimumDistance": 15.0,
    "minimumLength": 10.0,
    "minimumSlope": 0.25, // only when polyline || curved
    "sourcePortOptimization": false,
    "targetPortOptimization": false,
    "recursiveEdgeStyle": "OFF" //RecursiveEdgeStyle
  },
  "layerer": { //��������� ���� ��� ������������ ������� �� �����
    "nodeHalo": 0,
    "nodeScalingFactor": 1.0,
    "minimumNodeSize": 0,
    "maximumNodeSize": 1000.0
  },
  "nodePlacer": {
    "barycenterMode": false,
    "straightenEdges": false,
    "groupCompactionStrategy": "NONE", //GroupCompactionPolicy
    "labelCompaction": true
  },
  "labeling": {
    "placeEdgeLabels": true,
    "placeNodeLabels": true
  },
  "treatRootGroupAsSwimlanes": { //������������ �� ��� stage can be used for automatically assigning SwimlaneDescriptor instances to nodes by treating top-level group nodes as swimlanes.
    "orderSwimlanesFromSketch": false,
    "spacing": 1
  },
  "layoutData": {
    //����� ��������� ������� ����������� �����
  },
  "executor": {
    "duration": "0.75s",
    "animateViewport": true,
    "easedAnimation": true,
    "portAdjustmentPolicy": "lengthen",
    "labelPreferredPlacementPolicy": "from-parameter" //����� �������� ������ ����������� ������ � ����� ������� �������� ��������
  },
  "abortHandler": {
    "cancelDuration": "20s"
  }
}
```

## flowchart.json

```json
{
  "module": "hierarchiclayoutconfig",
  "edgeLabeling": "INTEGRATED", //defines how labeling stage is performed NONE, GENERIC or INTEGRATED
  "layout": {
    "layoutMode": "FROM_SCRATCH", //�� ��������� ���� � ����, ����� ������������� ������ INCREMENTAL
    "fromScratchLayeringStrategy": "HIERARCHICAL_OPTIMAL", //HierarchicLayoutLayeringStrategy
    "layoutOrientation": "TOP_TO_BOTTOM",

    "gridSpacing": 0, //�������� �� ����

    //������� �� �� ��� �������������� ����
    "orthogonalRouting": true,
    "backLoopRouting": true, // ��� ������ � ����������� ������
    "backLoopRoutingForSelfLoops": true,

    //������ � ��������
    "labelingEnabled": true, //����� �� ����������� ������ ����������� �������

    "componentArrangementPolicy": "COMPACT"
  },
  //�������. ������������� ����� ��������� � layoutData
  "edgeLayoutDescriptor": {
    "routingStyle": {
      "type": "ORTHOGONAL" //HierarchicLayoutEdgeRoutingStyle
    },
    "minimumFirstSegmentLength": 5.0,
    "minimumLastSegmentLength": 5.0,
    "minimumDistance": 5.0,
    "minimumLength": 5.0
  },
  "nodePlacer": {
    "barycenterMode": true,
    "straightenEdges": false,
    "labelCompaction": true
  },
  "labeling": {
    "placeEdgeLabels": true,
    "placeNodeLabels": true
  },
  "layoutData": {
    "layoutData": {
      "highlightCriticalPath": true,
      "edgeDirectedness": true,
      "automaticBusRoutingEnabled": true,
      "labelingData": {
        "labelPlacementAlongEdge": "CENTERED",
        "labelPlacementSideOfEdge": "LEFT_OR_RIGHT",
        "labelPlacementOrientation": "HORIZONTAL",
        "labelPlacementDistance": 5
      }
    }
  },
  "executor": {
    "duration": "0.75s",
    "animateViewport": true,
    "easedAnimation": true
  }
}
```

## bpmn.json

```json
{
  "module": "bpmnlayoutconfig",
  "edgeLabeling": "GENERIC",
  "layout": {
    "layoutMode": "FROM_SCRATCH",
    "layoutOrientation": "LEFT_TO_RIGHT",
    "orthogonalRouting": true,
    "recursiveGroupLayering": false,
    "componentLayoutEnabled": false,
    "nodeToNodeDistance": 40.0,
    "minimumLayerDistance": 40.0
  },
  "nodePlacer": {
    "barycenterMode": true,
    "straightenEdges": true
  },
  "labeling": {
    "reduceAmbiguity": true,
    "placeEdgeLabels": true,
    "placeNodeLabels": true,
    "customProfitModelRatio": 0.15
  },
  "layoutData": {
    "edgeDirectedness": true
  },
  "executor": {
    "duration": "0.75s",
    "animateViewport": true,
    "easedAnimation": true
  },
  "tableLayoutConfigurator": {
    "horizontalLayout": true,
    "fromSketch": true
  }
}
```

## orthogonal.json

```json
{
  "module": "orthogonalconfig",
  "layout": {
    "styleItem": "NORMAL",
    "gridSpacingItem":15,
    "edgeLengthReductionItem" : true,
    "useExistingDrawingAsSketchItem":false,
    "crossingReductionItem" :true,
    "perceivedBendsPostprocessingItem":true,
    "uniformPortAssignmentItem" : false,
    "useRandomizationItem":true,
    "useFaceMaximizationItem" : false,
    "considerNodeLabelsItem": false,
    "labelPlacementDistanceItem" :10,
    "minimumFirstSegmentLengthItem": 15,
    "minimumSegmentLengthItem" : 15.0,
    "minimumLastSegmentLengthItem": 15.0,
    "considerEdgeDirectionItem" :false
  },
  "layoutData": {
  },
  "executor": {
    "duration": "0.75s",
    "animateViewport": true,
    "easedAnimation": true
  }
}
```

## hierarhic.json

```json
{
  "module": "hierarchiclayoutconfig",
  "layout": {
    "componentLayoutEnabled": false,
    "layoutOrientation": "TOP_TO_BOTTOM",
    "orthogonalRouting": true,
    "recursiveGroupLayering": true,
    "gridSpacing": 15
  },
  "nodeLayoutDescriptor": {
    "portAssignment": "ON_GRID"
  },
  "layoutData": {
    "edgeDirectedness": true,
    "automaticBusRoutingEnabled": true
  },
  "executor": {
    "duration": "0.75s",
    "animateViewport": true,
    "easedAnimation": true
  },
  "abortHandler": {
    "cancelDuration": "20s"
  }
}
```
